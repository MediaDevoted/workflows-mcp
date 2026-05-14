#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AgentPlatformClient, type WorkflowDto, type WorkflowSummary } from "./agent-platform.js";
import { syncCatalogOnBoot } from "./catalog-sync.js";
import { loadConfig } from "./config.js";
import { EmployeeApiClient } from "./employee-api.js";
import { jsonText } from "./format.js";
import { manifestPayload, toolPermissionKey, TOOLS_MANIFEST } from "./manifest.js";
import { employeeApiKeyFromHeaders, runWithRequestContext } from "./request-context.js";
import { applyHiddenFilter, ToolVisibilityClient } from "./tool-visibility.js";
import {
  EmbeddingsClient,
  EmbeddingsStore,
  EmbeddingsUnavailableError,
  StoreUnavailableError,
  SyncRunner,
  embeddingDimensions,
  type SearchHit,
  type SearchMode,
} from "./search/index.js";

const config = loadConfig();
const employeeApi = new EmployeeApiClient(config.employeeApi);
const agentPlatform = new AgentPlatformClient(config.agentPlatform);
const toolVisibility = new ToolVisibilityClient({
  baseUrl: config.agentPlatform.baseUrl,
  apiKey: config.agentPlatform.apiKey,
  connector: "workflows",
  log: (message) => process.stderr.write(`[workflows-mcp][tool-visibility] ${message}\n`),
});

let embeddingsClient: EmbeddingsClient | null = null;
let embeddingsStore: EmbeddingsStore | null = null;

function log(message: string): void {
  process.stderr.write(`[workflows-mcp] ${message}\n`);
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function json(value: unknown) {
  return text(jsonText(value, config.responseMaxBytes));
}

async function governed<T>(
  args: {
    toolName: string;
    permission: string;
    action: string;
    resourceType?: string;
    resourceId?: string;
    risk?: string;
    metadata?: Record<string, unknown>;
  },
  fn: () => Promise<T>,
) {
  const decision = await employeeApi.authorize([args.permission, toolPermissionKey(args.toolName)]);
  if (!decision.ok) {
    await employeeApi.audit({
      action: args.action,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      risk: args.risk,
      decision: "deny",
      status: "skipped",
      metadata: { reason: decision.reason, ...args.metadata },
      error: decision.reason,
    });
    return json({ ok: false, denied: true, reason: decision.reason });
  }

  try {
    const result = await fn();
    await employeeApi.audit({
      action: args.action,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      risk: args.risk,
      decision: "allow",
      status: "success",
      metadata: args.metadata,
    });
    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await employeeApi.audit({
      action: args.action,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      risk: args.risk,
      decision: "allow",
      status: "error",
      metadata: args.metadata,
      error: message,
    });
    return json({ ok: false, error: message });
  }
}

interface ScoredWorkflow {
  slug: string;
  title: string;
  description: string;
  score: number;
  matched_triggers: string[];
}

function scoreWorkflow(workflow: WorkflowSummary, query: string): ScoredWorkflow {
  const needle = query.trim().toLowerCase();
  const tokens = needle.split(/\s+/).filter(Boolean);
  const title = (workflow.title ?? "").toLowerCase();
  const description = (workflow.description ?? "").toLowerCase();
  const triggers = (workflow.triggers ?? []).map((t) => t.toLowerCase());

  const matchedTriggers = triggers.filter((t) => t.includes(needle) || tokens.some((tok) => t.includes(tok)));

  let score = 0;
  for (const tok of tokens) {
    if (title.includes(tok)) score += 3;
    if (triggers.some((t) => t.includes(tok))) score += 2;
    if (description.includes(tok)) score += 1;
  }
  if (needle && title.includes(needle)) score += 3;

  return {
    slug: workflow.slug,
    title: workflow.title,
    description: workflow.description,
    score,
    matched_triggers: workflow.triggers?.filter((t) => matchedTriggers.includes(t.toLowerCase())) ?? [],
  };
}

function summarize(workflow: WorkflowDto) {
  return {
    slug: workflow.slug,
    title: workflow.title,
    description: workflow.description,
    bodyMarkdown: workflow.bodyMarkdown,
    triggers: workflow.triggers ?? [],
    connectors: workflow.connectors ?? [],
    assignedRoles: workflow.assignedRoles ?? [],
  };
}

function createMcpServerInstance(): McpServer {
  const server = new McpServer({
    name: "workflows-mcp",
    version: "0.1.0",
  }, {
    capabilities: {
      tools: {},
      resources: {},
    },
  });

  server.resource(
    "workflows-overview",
    "workflows://overview",
    async () => ({
      contents: [{
        uri: "workflows://overview",
        mimeType: "text/markdown",
        text: `# Workflows MCP

A read-only MCP server that exposes MediaDevoted workflow playbooks — markdown
documents that describe how to combine the OTHER MCPs (namecheap, cloudflare,
voluum, blast, hosting, etc.) to accomplish complex operational tasks.

This server is a thin wrapper over agent-platform's \`/workflows\` REST API.
Auth is per-request: the caller's Employee API bearer key is forwarded to
agent-platform, which enforces role-based visibility (intersect caller roles
with each workflow's assignedRoles).

## Tools
- \`workflows_list\` — list visible workflows, with optional connector / role / search filters.
- \`workflows_search\` — search and locally re-rank results.
- \`workflows_read\` — read one workflow's bodyMarkdown plus any prerequisite (mustReadBefore) workflows.
`,
      }],
    }),
  );

  server.resource(
    "workflows-how-to-use",
    "workflows://how-to-use",
    async () => ({
      contents: [{
        uri: "workflows://how-to-use",
        mimeType: "text/markdown",
        text: `# How to use workflows-mcp

When the user gives you a task that touches multiple connectors or that has
operational gotchas (DNS cutovers, domain rotation, campaign launches, etc.),
**ask the workflow catalog first** before improvising.

## Pattern

1. \`workflows_list({ connector: "namecheap" })\` — see what playbooks exist for the connector(s) you're about to touch. Or
   \`workflows_search({ query: "rotate to cloudflare" })\` — keyword search the catalog.
2. Pick the workflow whose triggers/title/description best matches the task. Inspect its \`assignedRoles\` to confirm it's intended for an agent like you.
3. \`workflows_read({ slug })\` — pulls the full markdown plus any prerequisite workflows (\`Includes\`). **Read the prerequisites first**, then the main workflow.
4. Follow the playbook's steps. The workflow tells you which other MCPs to call and in what order.

## When NOT to use
- Single-step trivia (e.g. "what's my Namecheap balance") — just call the tool directly.
- The workflow catalog is empty for this connector — fall back to your normal reasoning.

## Output shape
- \`workflows_read\` returns \`{ workflow, prerequisites[], instructions }\`. Always honor \`instructions\` and read prerequisites before the main workflow body.
- 404 → \`{ ok: false, reason: "workflow_not_found" }\`.
- 403 → \`{ ok: false, denied: true, reason: "workflow_not_assigned_to_your_roles" }\` — the workflow exists but is not assigned to any role you hold; do not try to guess its content.
`,
      }],
    }),
  );

  server.resource(
    "workflows-tools-manifest",
    "workflows://tools-manifest",
    async () => ({
      contents: [{
        uri: "workflows://tools-manifest",
        mimeType: "application/json",
        text: JSON.stringify(manifestPayload({ tool_count: TOOLS_MANIFEST.length }), null, 2),
      }],
    }),
  );

  server.tool(
    "workflows_list",
    "List workflow playbooks visible to the caller. Optional filters: connector, assignedRole, search. Returns workflow summaries (slug, title, description, triggers, connectors, assignedRoles).",
    {
      connector: z.string().optional().describe("Filter by connector tag (e.g. 'namecheap', 'cloudflare')."),
      assignedRole: z.string().optional().describe("Filter to workflows assigned to a specific role."),
      search: z.string().optional().describe("Free-text search forwarded to agent-platform."),
    },
    async ({ connector, assignedRole, search }) => governed({
      toolName: "workflows_list",
      permission: config.employeeApi.readPermission,
      action: "workflow.list",
      resourceType: "workflow",
      metadata: { connector, assignedRole, search },
    }, async () => {
      const workflows = await agentPlatform.listWorkflows({ connector, assignedRole, search });
      return {
        ok: true,
        count: workflows.length,
        workflows,
        filters: { connector, assignedRole, search },
      };
    }),
  );

  server.tool(
    "workflows_search",
    "Semantic search over workflow playbooks via OpenAI embeddings + pgvector cosine similarity. mode='fast' (default) ranks on title+description+triggers; mode='deep' blends in the full body. Falls back to literal trigger ranking when embeddings are unavailable.",
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional().default(5),
      mode: z.enum(["fast", "deep"]).optional().default("fast"),
    },
    async ({ query, limit, mode }) => governed({
      toolName: "workflows_search",
      permission: config.employeeApi.readPermission,
      action: "workflow.search",
      resourceType: "workflow",
      metadata: { query, limit, mode },
    }, async () => {
      const visibleWorkflows = await agentPlatform.listWorkflows();
      const visibleSlugs = visibleWorkflows.map((w) => w.slug);

      if (visibleSlugs.length === 0) {
        return {
          ok: true,
          query,
          mode,
          total_visible: 0,
          returned: 0,
          results: [],
          embedded_query_dims: embeddingDimensions,
        };
      }

      if (embeddingsClient && embeddingsStore) {
        try {
          const vector = await embeddingsClient.embed(query);
          const hits: SearchHit[] = await embeddingsStore.query({
            embedding: vector,
            visibleSlugs,
            limit,
            mode: mode as SearchMode,
          });
          return {
            ok: true,
            query,
            mode,
            total_visible: visibleSlugs.length,
            returned: hits.length,
            results: hits,
            embedded_query_dims: embeddingDimensions,
          };
        } catch (error) {
          const tag = error instanceof EmbeddingsUnavailableError
            ? "embeddings-unavailable"
            : error instanceof StoreUnavailableError
              ? "store-unavailable"
              : "search-error";
          log(`workflows_search degraded (${tag}): ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const ranked = visibleWorkflows
        .map((workflow) => scoreWorkflow(workflow, query))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return {
        ok: true,
        degraded: true,
        query,
        mode,
        total_visible: visibleSlugs.length,
        returned: ranked.length,
        results: ranked,
      };
    }),
  );

  server.tool(
    "workflows_read",
    "Read a single workflow's bodyMarkdown plus any prerequisite workflows (mustReadBefore). Returns { workflow, prerequisites[], instructions }. Read prerequisites first.",
    {
      slug: z.string().min(1),
    },
    async ({ slug }) => governed({
      toolName: "workflows_read",
      permission: config.employeeApi.readPermission,
      action: "workflow.read",
      resourceType: "workflow",
      resourceId: slug,
      metadata: { slug },
    }, async () => {
      const result = await agentPlatform.readWorkflow(slug);
      if (!result.ok) {
        if (result.status === 404) return { ok: false, reason: "workflow_not_found" };
        if (result.status === 403) return { ok: false, denied: true, reason: "workflow_not_assigned_to_your_roles" };
        return { ok: false, error: result.reason };
      }
      return {
        ok: true,
        workflow: summarize(result.workflow),
        prerequisites: result.includes.map((entry) => ({
          slug: entry.slug,
          title: entry.title,
          bodyMarkdown: entry.bodyMarkdown,
        })),
        instructions: "Read prerequisites first, then the main workflow.",
      };
    }),
  );

  server.tool(
    "workflows_create",
    "Create a new workflow playbook. Slug is normalized to lower-kebab-case server-side. AssignedRoles gates which roles may read it (empty array = admins only). Requires MANAGE_WORKFLOWS.",
    {
      slug: z.string().min(1).describe("Lowercase kebab-case identifier, e.g. 'rotate-domains'."),
      title: z.string().min(1).describe("Human-readable title shown in lists."),
      bodyMarkdown: z.string().min(1).describe("Markdown runbook the agent reads when this workflow is invoked."),
      description: z.string().optional().describe("One-line summary shown alongside the title."),
      triggers: z.array(z.string()).optional().describe("Short trigger phrases used for prompt search."),
      connectors: z.array(z.string()).optional().describe("Connector keys this workflow uses (e.g. ['voluum','namecheap'])."),
      mustReadBefore: z.array(z.string()).optional().describe("Slugs of workflows auto-pulled when this one is read."),
      assignedRoles: z.array(z.string()).optional().describe("Role keys that may read this workflow. Empty array = visible only to admins."),
    },
    async (args) => governed({
      toolName: "workflows_create",
      permission: "MANAGE_WORKFLOWS",
      action: "workflow.create",
      resourceType: "workflow",
      resourceId: args.slug,
      risk: "medium",
      metadata: { slug: args.slug, title: args.title },
    }, async () => {
      const result = await agentPlatform.createWorkflow({
        slug: args.slug,
        title: args.title,
        bodyMarkdown: args.bodyMarkdown,
        description: args.description ?? null,
        triggers: args.triggers ?? null,
        connectors: args.connectors ?? null,
        mustReadBefore: args.mustReadBefore ?? null,
        assignedRoles: args.assignedRoles ?? null,
        source: "hermes",
      });
      if (!result.ok) {
        if (result.status === 403) return { ok: false, denied: true, reason: result.reason };
        return { ok: false, status: result.status, reason: result.reason };
      }
      return { ok: true, slug: result.result.slug };
    }),
  );

  server.tool(
    "workflows_update",
    "Update an existing workflow playbook. Slug is immutable. List fields (triggers/connectors/mustReadBefore/assignedRoles) are replaced when provided; omit to leave unchanged, pass [] to clear. Requires MANAGE_WORKFLOWS.",
    {
      slug: z.string().min(1).describe("Slug of the workflow to update."),
      title: z.string().min(1),
      bodyMarkdown: z.string().min(1),
      description: z.string().optional(),
      triggers: z.array(z.string()).optional(),
      connectors: z.array(z.string()).optional(),
      mustReadBefore: z.array(z.string()).optional(),
      assignedRoles: z.array(z.string()).optional(),
    },
    async (args) => governed({
      toolName: "workflows_update",
      permission: "MANAGE_WORKFLOWS",
      action: "workflow.update",
      resourceType: "workflow",
      resourceId: args.slug,
      risk: "medium",
      metadata: { slug: args.slug, title: args.title },
    }, async () => {
      const result = await agentPlatform.updateWorkflow(args.slug, {
        title: args.title,
        bodyMarkdown: args.bodyMarkdown,
        description: args.description ?? null,
        triggers: args.triggers ?? null,
        connectors: args.connectors ?? null,
        mustReadBefore: args.mustReadBefore ?? null,
        assignedRoles: args.assignedRoles ?? null,
        source: "hermes",
      });
      if (!result.ok) {
        if (result.status === 404) return { ok: false, reason: "workflow_not_found" };
        if (result.status === 403) return { ok: false, denied: true, reason: result.reason };
        return { ok: false, status: result.status, reason: result.reason };
      }
      return { ok: true, slug: args.slug.trim().toLowerCase() };
    }),
  );

  server.tool(
    "workflows_delete",
    "Delete a workflow playbook. DESTRUCTIVE — confirm must be true. References from other workflows' mustReadBefore are silently skipped after delete. Requires MANAGE_WORKFLOWS.",
    {
      slug: z.string().min(1).describe("Slug of the workflow to delete."),
      confirm: z.boolean().describe("Must be true; rejects otherwise. Forces an explicit second-step confirmation."),
    },
    async ({ slug, confirm }) => governed({
      toolName: "workflows_delete",
      permission: "MANAGE_WORKFLOWS",
      action: "workflow.delete",
      resourceType: "workflow",
      resourceId: slug,
      risk: "high",
      metadata: { slug, confirm },
    }, async () => {
      if (!confirm) {
        return {
          ok: false,
          reason: "confirmation_required",
          message: "Pass confirm=true to proceed. This deletes the workflow permanently.",
        };
      }
      const result = await agentPlatform.deleteWorkflow(slug);
      if (!result.ok) {
        if (result.status === 404) return { ok: false, reason: "workflow_not_found" };
        if (result.status === 403) return { ok: false, denied: true, reason: result.reason };
        return { ok: false, status: result.status, reason: result.reason };
      }
      return { ok: true, deleted: slug.trim().toLowerCase() };
    }),
  );

  // Apply the current tool-visibility hidden set and re-apply whenever it
  // refreshes. Disabled tools disappear from tools/list and reject tools/call
  // at the SDK level, so the LLM never sees the hidden surface.
  applyHiddenFilter(server, toolVisibility);
  const unsubscribe = toolVisibility.onChange(() => applyHiddenFilter(server, toolVisibility));
  // Drop the subscription when the underlying transport closes so we don't
  // leak listeners across reconnected HTTP sessions.
  const originalClose = server.close.bind(server);
  server.close = async () => {
    unsubscribe();
    await originalClose();
  };

  return server;
}

async function main(): Promise<void> {
  log(`transport=${config.transport} agentPlatform=${config.agentPlatform.baseUrl || "(unset)"} employeeApi=${config.employeeApi.baseUrl}`);
  if (config.employeeApi.authDisabled) log("Employee API auth disabled by EMPLOYEE_AUTH_DISABLED=true");

  await syncCatalogOnBoot({
    serverName: "workflows-mcp",
    manifest: manifestPayload({ tool_count: TOOLS_MANIFEST.length }),
    employeeApi: config.employeeApi,
    agentPlatform: config.agentPlatform,
    log,
  });

  // Prime the hidden-tools cache before any tools/list call goes out, then
  // start the background refresh. Empty set on first boot is the default —
  // existing behavior is preserved when agent-platform has no entries.
  await toolVisibility.refresh();
  toolVisibility.startBackgroundRefresh();
  log(`tool-visibility: ${toolVisibility.getHiddenCount()} tool(s) hidden`);

  if (!config.search.openaiApiKey) {
    log("semantic search disabled: OPENAI_API_KEY is not set (workflows_search will degrade to trigger ranking)");
  } else if (!config.search.syncApiKey) {
    log("semantic search disabled: no MCP_SYNC_API_KEY available for catalog sync");
  } else if (!config.agentPlatform.enabled) {
    log("semantic search disabled: AGENT_PLATFORM_URL is not set");
  } else {
    try {
      embeddingsClient = new EmbeddingsClient({ apiKey: config.search.openaiApiKey });
      embeddingsStore = new EmbeddingsStore(config.search.embeddingsDbUrl);
      const runner = new SyncRunner({
        agentPlatformBaseUrl: config.agentPlatform.baseUrl,
        syncApiKey: config.search.syncApiKey,
        store: embeddingsStore,
        embeddings: embeddingsClient,
        batchSize: Math.max(1, config.search.batchSize),
        intervalMs: config.search.syncIntervalMs,
        log,
      });
      runner.start();
      log(`semantic search enabled (interval=${config.search.syncIntervalMs}ms batch=${config.search.batchSize})`);
    } catch (error) {
      embeddingsClient = null;
      embeddingsStore = null;
      log(`semantic search init failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (config.transport === "http") {
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    const httpServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

      if (url.pathname === "/manifest" || url.pathname === "/tools-manifest") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(manifestPayload({ tool_count: TOOLS_MANIFEST.length })));
        return;
      }

      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (url.pathname !== "/mcp") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      if (config.mcpAuthToken) {
        const queryToken = url.searchParams.get("auth");
        const headerToken = req.headers["x-mcp-auth-token"];
        const token = Array.isArray(headerToken) ? headerToken[0] : headerToken;
        if (queryToken !== config.mcpAuthToken && token !== config.mcpAuthToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }

      const handle = async () => {
        if (req.method === "GET") {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          if (sessionId && sessions.has(sessionId)) {
            await sessions.get(sessionId)!.handleRequest(req, res);
            return;
          }
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method Not Allowed — use POST to initialize" }));
          return;
        }

        if (req.method === "DELETE") {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          if (sessionId && sessions.has(sessionId)) {
            sessions.delete(sessionId);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "session deleted" }));
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
          }
          return;
        }

        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport: StreamableHTTPServerTransport;
        if (sessionId && sessions.has(sessionId)) {
          transport = sessions.get(sessionId)!;
        } else if (!sessionId && req.method === "POST") {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              sessions.set(newSessionId, transport);
              log(`new session ${newSessionId}`);
            },
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) sessions.delete(sid);
          };
          await createMcpServerInstance().connect(transport);
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Bad request — no valid session" }));
          return;
        }

        await transport.handleRequest(req, res);
      };

      await runWithRequestContext({ employeeApiKey: employeeApiKeyFromHeaders(req) }, handle);
    });

    httpServer.listen(config.port, () => {
      log(`listening on http://0.0.0.0:${config.port}/mcp`);
    });
  } else {
    const server = createMcpServerInstance();
    await server.connect(new StdioServerTransport());
    log("running on stdio");
  }
}

main().catch((error) => {
  process.stderr.write(`[workflows-mcp] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
