#!/usr/bin/env node
/**
 * Workflows MCP server — v0.2.
 *
 * Migrated from the bespoke 1.x bootstrap to the shared v2 runtime in
 * `@mediadevoted/mcp-passthrough`. Transport/session/auth/dynamic-toolsets
 * wiring lives in `runMcpServer`; this file only owns the connector-specific
 * pieces: identity client, audit-trail client, workflow tool registration,
 * resources, and the optional pgvector-backed semantic search.
 *
 * workflows-mcp is the canonical store for team/account conventions and
 * playbooks consumed at runtime by other MCPs. The tool API
 * (`workflows_list`, `workflows_search`, `workflows_read`,
 * `workflows_create`, `workflows_update`, `workflows_delete`) is
 * backward-compatible with v0.1.x — only the bootstrap layer changed.
 */

import {
  buildAccountHints,
  CostTracker,
  DynamicToolsetV2Controller,
  EmployeeIdentityClient,
  err,
  errors,
  ok,
  registerCommonResources,
  runMcpServer,
  syncCatalogOnBoot,
  ToolVisibilityClient,
  toolResultToContent,
  type ToolResult,
} from "@mediadevoted/mcp-passthrough";
import { checkApprovalGate } from "@mediadevoted/mcp-passthrough/approval-gate";
import { AuditTrailClient } from "@mediadevoted/mcp-passthrough/audit-trail";
import { tagToolWithPermissionKey } from "@mediadevoted/mcp-passthrough/tools-list-filter";
import { z } from "zod";
import { AgentPlatformClient, type WorkflowDto, type WorkflowSummary } from "./agent-platform.js";
import { loadConfig } from "./config.js";
import {
  annotationsForTool,
  buildWorkflowsManifest,
  CONNECTOR,
  descriptionForTool,
  TOOL_NAMES,
  toolPermissionKey,
} from "./manifest.js";
import { scoreWorkflow } from "./ranking.js";
import {
  EmbeddingsClient,
  EmbeddingsStore,
  EmbeddingsUnavailableError,
  embeddingDimensions,
  StoreUnavailableError,
  SyncRunner,
  type SearchHit,
  type SearchMode,
} from "./search/index.js";

const SERVER_NAME = "workflows-mcp";
const SERVER_VERSION = "0.2.0";

const config = loadConfig();
const log = (m: string) => process.stderr.write(`[${SERVER_NAME}] ${m}\n`);

// workflows-mcp historically requires ALL of [coarse, per-tool] permissions on
// authorize(...) — keeps the legacy behavior where MANAGE_WORKFLOWS and the
// per-tool key must BOTH be present for writes. Voluum/Cloudflare default to
// ANY; this stays explicit.
const identity = new EmployeeIdentityClient({
  baseUrl: config.employeeApiUrl,
  connector: CONNECTOR,
  serviceKey: config.employeeApiServiceKey,
  authDisabled: config.employeeAuthDisabled,
  cacheSeconds: config.employeeAuthCacheSeconds,
  readPermission: config.readPermission,
  writePermission: config.writePermission,
  adminPermissions: config.adminPermissions,
  crossTeamReadPermissions: config.crossTeamReadPermissions,
  requireAll: true,
  log,
});

const agentPlatform = new AgentPlatformClient({
  baseUrl: config.agentPlatformUrl,
  apiKey: config.agentPlatformApiKey,
  enabled: config.agentPlatformEnabled,
  allowedTeams: config.allowedTeams,
});

const auditTrail = new AuditTrailClient({
  connector: CONNECTOR,
  baseUrl: config.auditTrailUrl,
  apiKey: config.auditTrailApiKey,
  enabled: config.auditTrailEnabled,
});

const toolVisibility = new ToolVisibilityClient({
  baseUrl: config.agentPlatformUrl,
  apiKey: config.agentPlatformApiKey,
  connector: CONNECTOR,
  log: (m) => log(`[tool-visibility] ${m}`),
});

const dynamicToolsets = new DynamicToolsetV2Controller({
  serverLabel: "workflows MCP",
  log: (m) => log(`[dynamic-toolsets-v2] ${m}`),
});
dynamicToolsets.setCategoryMeta("workflows", {
  examples: ["list workflows", "search workflows for cloudflare rotation", "read a workflow playbook"],
});

const costTracker = new CostTracker();

let embeddingsClient: EmbeddingsClient | null = null;
let embeddingsStore: EmbeddingsStore | null = null;
let embeddingsReady = false;

// ---------------------------------------------------------------------------
// Resource bodies
// ---------------------------------------------------------------------------

const WORKFLOWS_OVERVIEW = `# Workflows MCP

Governed access to the MediaDevoted workflow playbook catalog. Playbooks are
markdown documents that describe how to combine the OTHER MCPs (namecheap,
cloudflare, voluum, blast, hosting, ...) to accomplish complex operational
tasks.

This server is a thin RBAC-gated wrapper over agent-platform's \`/workflows\`
REST API. Auth is per-request: the caller's Employee API bearer key is
forwarded and agent-platform enforces role-based visibility (intersect caller
roles with each workflow's \`assignedRoles\`).

## Tools
- \`workflows_status\` — connector health.
- \`workflows_list\` — list visible workflows, with optional connector / role / search filters.
- \`workflows_search\` — semantic search via OpenAI embeddings + pgvector cosine similarity. Falls back to literal trigger ranking when embeddings are unavailable.
- \`workflows_read\` — read one workflow's bodyMarkdown plus any prerequisite (\`mustReadBefore\`) workflows.
- \`workflows_create\` / \`workflows_update\` / \`workflows_delete\` — manage workflows. Require \`MANAGE_WORKFLOWS\`. Delete is destructive and requires \`confirm=true\`.
`;

const WORKFLOWS_SAFETY = `# Workflows Safety Rules

- All write tools require \`MANAGE_WORKFLOWS\`. Read tools require \`WORKFLOWS_READ\` (admin perms satisfy both).
- \`workflows_delete\` is destructive — pass \`confirm=true\` AND an \`approval_note\` to dispatch, or \`dry_run=true\` to preview.
- Workflow content is consumed verbatim by other agents — keep titles and triggers stable across edits to avoid breaking cross-MCP discovery.
- Empty \`assignedRoles\` means the workflow is admin-only.
`;

const WORKFLOWS_OPERATOR_PLAYBOOK = `# How to use workflows-mcp

When the user gives you a task that touches multiple connectors or that has
operational gotchas (DNS cutovers, domain rotation, campaign launches, etc.),
**ask the workflow catalog first** before improvising.

## Pattern

1. \`workflows_list({ connector: "namecheap" })\` — see what playbooks exist for the connector(s) you're about to touch. Or
   \`workflows_search({ query: "rotate to cloudflare" })\` — semantic search the catalog.
2. Pick the workflow whose triggers/title/description best matches the task. Inspect its \`assignedRoles\` to confirm it's intended for an agent like you.
3. \`workflows_read({ slug })\` — pulls the full markdown plus any prerequisite workflows (\`Includes\`). **Read the prerequisites first**, then the main workflow.
4. Follow the playbook's steps. The workflow tells you which other MCPs to call and in what order.

## When NOT to use
- Single-step trivia (e.g. "what's my Namecheap balance") — just call the tool directly.
- The workflow catalog is empty for this connector — fall back to your normal reasoning.

## Output shape
- \`workflows_read\` returns \`{ workflow, prerequisites[], instructions }\`. Always honor \`instructions\` and read prerequisites before the main workflow body.
- 404 / 403 surface as a normalized \`ToolError\` (\`NOT_FOUND\` / \`DENIED\`).
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildManifest = () => buildWorkflowsManifest(config.adminPermissions, config.readPermission, config.writePermission);

function summarize(workflow: WorkflowDto | WorkflowSummary): Record<string, unknown> {
  const w = workflow as WorkflowDto;
  return {
    slug: w.slug,
    title: w.title,
    description: w.description,
    bodyMarkdown: w.bodyMarkdown,
    triggers: w.triggers ?? [],
    connectors: w.connectors ?? [],
    assignedRoles: w.assignedRoles ?? [],
  };
}

function reply<T>(result: ToolResult<T>) {
  return toolResultToContent(result, config.responseMaxBytes);
}

interface GovernedArgs {
  toolName: string;
  permission: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  risk?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Wrap a tool body with RBAC + audit. Maps the identity decision to
 * `ToolError` and writes one audit row per call.
 */
async function governed<T>(args: GovernedArgs, fn: () => Promise<ToolResult<T>>): Promise<ToolResult<T>> {
  const decision = await identity.authorize([args.permission, toolPermissionKey(args.toolName)]);
  if (!decision.ok) {
    await auditTrail.write({
      action: args.action,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      risk: args.risk,
      decision: "deny",
      status: "skipped",
      metadata: { reason: decision.error.message, ...args.metadata },
      error: decision.error.message,
    });
    return err(decision.error) as ToolResult<T>;
  }

  try {
    const result = await fn();
    await auditTrail.write({
      action: args.action,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      risk: args.risk,
      decision: "allow",
      status: result.ok ? "success" : "error",
      metadata: args.metadata,
      error: result.ok ? undefined : result.error.message,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await auditTrail.write({
      action: args.action,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      risk: args.risk,
      decision: "allow",
      status: "error",
      metadata: args.metadata,
      error: message,
    });
    return err(errors.internal(message)) as ToolResult<T>;
  }
}

function initEmbeddings(): void {
  if (!config.search.openaiApiKey) {
    log("semantic search disabled: OPENAI_API_KEY is not set (workflows_search will degrade to trigger ranking)");
    return;
  }
  if (!config.search.syncApiKey) {
    log("semantic search disabled: no MCP_SYNC_API_KEY available for catalog sync");
    return;
  }
  if (!config.agentPlatformEnabled) {
    log("semantic search disabled: AGENT_PLATFORM_URL is not set");
    return;
  }
  try {
    embeddingsClient = new EmbeddingsClient({ apiKey: config.search.openaiApiKey });
    embeddingsStore = new EmbeddingsStore(config.search.embeddingsDbUrl);
    const runner = new SyncRunner({
      agentPlatformBaseUrl: config.agentPlatformUrl,
      syncApiKey: config.search.syncApiKey,
      store: embeddingsStore,
      embeddings: embeddingsClient,
      batchSize: Math.max(1, config.search.batchSize),
      intervalMs: config.search.syncIntervalMs,
      log,
    });
    runner.start();
    embeddingsReady = true;
    log(`semantic search enabled (interval=${config.search.syncIntervalMs}ms batch=${config.search.batchSize})`);
  } catch (error) {
    embeddingsClient = null;
    embeddingsStore = null;
    embeddingsReady = false;
    log(`semantic search init failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

interface RegisterToolsContext {
  server: {
    tool: (name: string, description: string, shape: Record<string, z.ZodTypeAny>, handler: (args: Record<string, unknown>) => Promise<unknown>) => unknown;
  };
}

function registerStatus(ctx: RegisterToolsContext): void {
  const TOOL_NAME = "workflows_status";
  ctx.server.tool(
    TOOL_NAME,
    descriptionForTool(TOOL_NAME),
    {},
    async () => reply(
      ok({
        connector: CONNECTOR,
        version: SERVER_VERSION,
        agent_platform_configured: config.agentPlatformEnabled,
        audit_trail_configured: config.auditTrailEnabled,
        auth_disabled: config.employeeAuthDisabled,
        embeddings_enabled: embeddingsReady,
        embedded_query_dims: embeddingDimensions,
      }),
    ),
  );
  tagToolWithPermissionKey(ctx.server, TOOL_NAME, toolPermissionKey(TOOL_NAME));
}

function registerList(ctx: RegisterToolsContext): void {
  const TOOL_NAME = "workflows_list";
  ctx.server.tool(
    TOOL_NAME,
    descriptionForTool(TOOL_NAME),
    {
      connector: z.string().optional().describe("Filter by connector tag (e.g. 'namecheap', 'cloudflare')."),
      assignedRole: z.string().optional().describe("Filter to workflows assigned to a specific role."),
      search: z.string().optional().describe("Free-text search forwarded to agent-platform."),
    },
    async (raw) => {
      const connector = typeof raw.connector === "string" ? raw.connector : undefined;
      const assignedRole = typeof raw.assignedRole === "string" ? raw.assignedRole : undefined;
      const search = typeof raw.search === "string" ? raw.search : undefined;

      const result = await governed(
        {
          toolName: TOOL_NAME,
          permission: config.readPermission,
          action: "workflow.list",
          resourceType: "workflow",
          metadata: { connector, assignedRole, search },
        },
        async () => {
          try {
            const workflows = await agentPlatform.listWorkflows({ connector, assignedRole, search });
            return ok({
              count: workflows.length,
              workflows,
              filters: { connector, assignedRole, search },
            });
          } catch (error) {
            return err(errors.internal(error instanceof Error ? error.message : String(error)));
          }
        },
      );
      return reply(result);
    },
  );
  tagToolWithPermissionKey(ctx.server, TOOL_NAME, toolPermissionKey(TOOL_NAME));
}

function registerSearch(ctx: RegisterToolsContext): void {
  const TOOL_NAME = "workflows_search";
  ctx.server.tool(
    TOOL_NAME,
    descriptionForTool(TOOL_NAME),
    {
      query: z.string().min(1).optional().describe("Free-text query. Required."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum hits to return (1-20). Default 5."),
      mode: z.enum(["fast", "deep"]).optional().describe("'fast' ranks on title/description/triggers (default); 'deep' blends in the full body."),
    },
    async (raw) => {
      // Defensive: dynamic-toolsets-v2's execute_tool forwards args to handlers
      // bypassing Zod, so we coerce here. Without these guards, a missing/
      // non-string `query` crashed in `scoreWorkflow` and the embeddings
      // client.
      const safeQuery = typeof raw.query === "string" ? raw.query.trim() : "";
      const safeLimit = typeof raw.limit === "number" && Number.isFinite(raw.limit) ? Math.min(Math.max(1, Math.trunc(raw.limit)), 20) : 5;
      const safeMode: SearchMode = raw.mode === "deep" ? "deep" : "fast";

      const result = await governed<unknown>(
        {
          toolName: TOOL_NAME,
          permission: config.readPermission,
          action: "workflow.search",
          resourceType: "workflow",
          metadata: { query: safeQuery, limit: safeLimit, mode: safeMode },
        },
        async () => {
          if (!safeQuery) {
            return err(errors.missingParam("query", "Pass a non-empty query string."));
          }

          let visibleWorkflows: WorkflowSummary[];
          try {
            visibleWorkflows = await agentPlatform.listWorkflows();
          } catch (error) {
            return err(errors.internal(error instanceof Error ? error.message : String(error)));
          }
          const visibleSlugs = visibleWorkflows.map((w) => w.slug);

          if (visibleSlugs.length === 0) {
            return ok({
              query: safeQuery,
              mode: safeMode,
              total_visible: 0,
              returned: 0,
              results: [] as SearchHit[],
              embedded_query_dims: embeddingDimensions,
            });
          }

          if (embeddingsClient && embeddingsStore) {
            try {
              const vector = await embeddingsClient.embed(safeQuery);
              const hits: SearchHit[] = await embeddingsStore.query({
                embedding: vector,
                visibleSlugs,
                limit: safeLimit,
                mode: safeMode,
              });
              return ok({
                query: safeQuery,
                mode: safeMode,
                total_visible: visibleSlugs.length,
                returned: hits.length,
                results: hits,
                embedded_query_dims: embeddingDimensions,
              });
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
            .map((workflow) => scoreWorkflow(workflow, safeQuery))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, safeLimit);

          return ok({
            degraded: true,
            query: safeQuery,
            mode: safeMode,
            total_visible: visibleSlugs.length,
            returned: ranked.length,
            results: ranked,
          });
        },
      );
      return reply(result);
    },
  );
  tagToolWithPermissionKey(ctx.server, TOOL_NAME, toolPermissionKey(TOOL_NAME));
}

function registerRead(ctx: RegisterToolsContext): void {
  const TOOL_NAME = "workflows_read";
  ctx.server.tool(
    TOOL_NAME,
    descriptionForTool(TOOL_NAME),
    {
      slug: z.string().min(1).describe("Slug of the workflow to read."),
    },
    async (raw) => {
      const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
      const result = await governed(
        {
          toolName: TOOL_NAME,
          permission: config.readPermission,
          action: "workflow.read",
          resourceType: "workflow",
          resourceId: slug,
          metadata: { slug },
        },
        async () => {
          if (!slug) return err(errors.missingParam("slug"));
          const upstream = await agentPlatform.readWorkflow(slug);
          if (!upstream.ok) {
            if (upstream.status === 404) return err(errors.notFound("workflow", slug));
            if (upstream.status === 403) {
              return err(errors.denied("workflow_not_assigned_to_your_roles", "Ask an operator to assign this workflow to one of your roles."));
            }
            return err(errors.upstreamHttp(upstream.status, upstream.reason));
          }
          return ok({
            workflow: summarize(upstream.workflow),
            prerequisites: upstream.includes.map((entry) => ({
              slug: entry.slug,
              title: entry.title,
              bodyMarkdown: entry.bodyMarkdown,
            })),
            instructions: "Read prerequisites first, then the main workflow.",
          });
        },
      );
      return reply(result);
    },
  );
  tagToolWithPermissionKey(ctx.server, TOOL_NAME, toolPermissionKey(TOOL_NAME));
}

function registerCreate(ctx: RegisterToolsContext): void {
  const TOOL_NAME = "workflows_create";
  ctx.server.tool(
    TOOL_NAME,
    descriptionForTool(TOOL_NAME),
    {
      slug: z.string().min(1).describe("Lowercase kebab-case identifier, e.g. 'rotate-domains'."),
      title: z.string().min(1).describe("Human-readable title shown in lists."),
      bodyMarkdown: z.string().min(1).describe("Markdown runbook the agent reads when this workflow is invoked."),
      description: z.string().optional().describe("One-line summary shown alongside the title."),
      triggers: z.array(z.string()).optional().describe("Short trigger phrases used for prompt search."),
      connectors: z.array(z.string()).optional().describe("Connector keys this workflow uses (e.g. ['voluum','namecheap'])."),
      mustReadBefore: z.array(z.string()).optional().describe("Slugs of workflows auto-pulled when this one is read."),
      assignedRoles: z.array(z.string()).optional().describe("Role keys that may read this workflow. Empty array = visible only to admins."),
      dry_run: z.boolean().optional().describe("When true, validate inputs but skip dispatch."),
      confirm: z.boolean().optional().describe("Must be true for live dispatch."),
      approval_note: z.string().optional().describe("Optional human-readable note recorded in the audit row."),
    },
    async (raw) => {
      const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
      const title = typeof raw.title === "string" ? raw.title : "";
      const bodyMarkdown = typeof raw.bodyMarkdown === "string" ? raw.bodyMarkdown : "";

      const result = await governed<unknown>(
        {
          toolName: TOOL_NAME,
          permission: config.writePermission,
          action: "workflow.create",
          resourceType: "workflow",
          resourceId: slug,
          risk: "medium",
          metadata: { slug, title },
        },
        async () => {
          if (!slug) return err(errors.missingParam("slug"));
          if (!title) return err(errors.missingParam("title"));
          if (!bodyMarkdown) return err(errors.missingParam("bodyMarkdown"));

          const gate = checkApprovalGate(raw as { dry_run?: unknown; confirm?: unknown; approval_note?: unknown });
          if (!gate.ok) return err(gate.error);
          if (gate.dryRun) {
            return ok({
              dry_run: true,
              would_create: { slug, title, description: raw.description, assignedRoles: raw.assignedRoles ?? null },
            });
          }

          const upstream = await agentPlatform.createWorkflow({
            slug,
            title,
            bodyMarkdown,
            description: typeof raw.description === "string" ? raw.description : null,
            triggers: Array.isArray(raw.triggers) ? (raw.triggers as string[]) : null,
            connectors: Array.isArray(raw.connectors) ? (raw.connectors as string[]) : null,
            mustReadBefore: Array.isArray(raw.mustReadBefore) ? (raw.mustReadBefore as string[]) : null,
            assignedRoles: Array.isArray(raw.assignedRoles) ? (raw.assignedRoles as string[]) : null,
            source: "hermes",
          });
          if (!upstream.ok) {
            if (upstream.status === 403) return err(errors.denied(upstream.reason));
            if (upstream.status === 400) return err(errors.validation(upstream.reason));
            return err(errors.upstreamHttp(upstream.status, upstream.reason));
          }
          return ok({ slug: upstream.result.slug });
        },
      );
      return reply(result);
    },
  );
  tagToolWithPermissionKey(ctx.server, TOOL_NAME, toolPermissionKey(TOOL_NAME));
}

function registerUpdate(ctx: RegisterToolsContext): void {
  const TOOL_NAME = "workflows_update";
  ctx.server.tool(
    TOOL_NAME,
    descriptionForTool(TOOL_NAME),
    {
      slug: z.string().min(1).describe("Slug of the workflow to update."),
      title: z.string().min(1),
      bodyMarkdown: z.string().min(1),
      description: z.string().optional(),
      triggers: z.array(z.string()).optional(),
      connectors: z.array(z.string()).optional(),
      mustReadBefore: z.array(z.string()).optional(),
      assignedRoles: z.array(z.string()).optional(),
      dry_run: z.boolean().optional(),
      confirm: z.boolean().optional(),
      approval_note: z.string().optional(),
    },
    async (raw) => {
      const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
      const title = typeof raw.title === "string" ? raw.title : "";
      const bodyMarkdown = typeof raw.bodyMarkdown === "string" ? raw.bodyMarkdown : "";

      const result = await governed<unknown>(
        {
          toolName: TOOL_NAME,
          permission: config.writePermission,
          action: "workflow.update",
          resourceType: "workflow",
          resourceId: slug,
          risk: "medium",
          metadata: { slug, title },
        },
        async () => {
          if (!slug) return err(errors.missingParam("slug"));
          if (!title) return err(errors.missingParam("title"));
          if (!bodyMarkdown) return err(errors.missingParam("bodyMarkdown"));

          const gate = checkApprovalGate(raw as { dry_run?: unknown; confirm?: unknown; approval_note?: unknown });
          if (!gate.ok) return err(gate.error);
          if (gate.dryRun) {
            return ok({
              dry_run: true,
              would_update: { slug, title, description: raw.description },
            });
          }

          const upstream = await agentPlatform.updateWorkflow(slug, {
            title,
            bodyMarkdown,
            description: typeof raw.description === "string" ? raw.description : null,
            triggers: Array.isArray(raw.triggers) ? (raw.triggers as string[]) : null,
            connectors: Array.isArray(raw.connectors) ? (raw.connectors as string[]) : null,
            mustReadBefore: Array.isArray(raw.mustReadBefore) ? (raw.mustReadBefore as string[]) : null,
            assignedRoles: Array.isArray(raw.assignedRoles) ? (raw.assignedRoles as string[]) : null,
            source: "hermes",
          });
          if (!upstream.ok) {
            if (upstream.status === 404) return err(errors.notFound("workflow", slug));
            if (upstream.status === 403) return err(errors.denied(upstream.reason));
            if (upstream.status === 400) return err(errors.validation(upstream.reason));
            return err(errors.upstreamHttp(upstream.status, upstream.reason));
          }
          return ok({ slug: slug.toLowerCase() });
        },
      );
      return reply(result);
    },
  );
  tagToolWithPermissionKey(ctx.server, TOOL_NAME, toolPermissionKey(TOOL_NAME));
}

function registerDelete(ctx: RegisterToolsContext): void {
  const TOOL_NAME = "workflows_delete";
  ctx.server.tool(
    TOOL_NAME,
    descriptionForTool(TOOL_NAME),
    {
      slug: z.string().min(1).describe("Slug of the workflow to delete."),
      dry_run: z.boolean().optional().describe("When true, validate inputs but skip dispatch."),
      confirm: z.boolean().optional().describe("Must be true; rejects otherwise. Forces an explicit second-step confirmation."),
      approval_note: z.string().optional().describe("Human-readable rationale recorded in the audit row."),
    },
    async (raw) => {
      const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
      const result = await governed<unknown>(
        {
          toolName: TOOL_NAME,
          permission: config.writePermission,
          action: "workflow.delete",
          resourceType: "workflow",
          resourceId: slug,
          risk: "high",
          metadata: { slug },
        },
        async () => {
          if (!slug) return err(errors.missingParam("slug"));
          const gate = checkApprovalGate(raw as { dry_run?: unknown; confirm?: unknown; approval_note?: unknown });
          if (!gate.ok) return err(gate.error);
          if (gate.dryRun) {
            return ok({ dry_run: true, would_delete: slug });
          }

          const upstream = await agentPlatform.deleteWorkflow(slug);
          if (!upstream.ok) {
            if (upstream.status === 404) return err(errors.notFound("workflow", slug));
            if (upstream.status === 403) return err(errors.denied(upstream.reason));
            return err(errors.upstreamHttp(upstream.status, upstream.reason));
          }
          return ok({ deleted: slug.toLowerCase() });
        },
      );
      return reply(result);
    },
  );
  tagToolWithPermissionKey(ctx.server, TOOL_NAME, toolPermissionKey(TOOL_NAME));
}

export function registerWorkflowsTools(server: RegisterToolsContext["server"]): void {
  const ctx: RegisterToolsContext = { server };
  registerStatus(ctx);
  registerList(ctx);
  registerSearch(ctx);
  registerRead(ctx);
  registerCreate(ctx);
  registerUpdate(ctx);
  registerDelete(ctx);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`transport=${config.transport} agentPlatform=${config.agentPlatformUrl || "(unset)"} employeeApi=${config.employeeApiUrl}`);
  if (config.employeeAuthDisabled) log("Employee API auth disabled by EMPLOYEE_AUTH_DISABLED=true");

  await syncCatalogOnBoot({
    serverName: SERVER_NAME,
    manifest: buildManifest(),
    identity,
    agentPlatform: {
      baseUrl: config.agentPlatformUrl,
      apiKey: config.agentPlatformApiKey,
      enabled: config.agentPlatformEnabled,
      allowedTeams: config.allowedTeams,
    },
    adminPermissions: config.adminPermissions,
    log,
  });

  initEmbeddings();

  // workflows-mcp has no per-tenant accounts — the server-level instructions
  // just point the LLM at the operator playbook.
  const accountHints = buildAccountHints<{ id: string; label?: string }>([], {
    baseInstructions:
      "Workflows MCP — governed access to the MediaDevoted workflow playbook catalog. RBAC-gated read + write tools over the agent-platform `/workflows` API.",
    grantHint: "All callers see the workflow catalog scoped to roles they hold. To author workflows, the caller needs MANAGE_WORKFLOWS.",
  });
  const instructions = `${accountHints}\n\n${WORKFLOWS_OPERATOR_PLAYBOOK}`;

  const handle = await runMcpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    transport: config.transport,
    port: config.port,
    mcpAuthToken: config.mcpAuthToken,
    identity,
    adminPermissions: config.adminPermissions,
    dynamicToolsets,
    toolVisibility,
    costTracker,
    instructions,
    manifestPayload: buildManifest,
    healthPayload: () => ({
      status: "ok",
      agent_platform: config.agentPlatformEnabled ? "configured" : "unset",
      auth_disabled: config.employeeAuthDisabled,
      embeddings_enabled: embeddingsReady,
    }),
    log,
    buildInstance: async () => {
      const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
      const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {}, resources: {} }, instructions },
      );

      registerCommonResources(
        server,
        CONNECTOR,
        {
          overview: WORKFLOWS_OVERVIEW,
          safety: WORKFLOWS_SAFETY,
          operatorPlaybook: WORKFLOWS_OPERATOR_PLAYBOOK,
        },
        buildManifest,
      );

      registerWorkflowsTools(server as unknown as RegisterToolsContext["server"]);

      return { server };
    },
  });

  log(`${SERVER_NAME} ready${handle.port ? ` on :${handle.port}` : ""}`);
}

// Only run the server when this module is the entrypoint. Importing it from
// the contract-suite test pulls in `registerWorkflowsTools` + `buildManifest`
// without booting the HTTP transport.
function isEntrypoint(): boolean {
  try {
    const entry = process.argv[1] ?? "";
    return entry.endsWith("/dist/index.js") || entry.endsWith("/src/index.ts") || entry.endsWith("workflows-mcp");
  } catch {
    return true;
  }
}

if (isEntrypoint() && process.env.WORKFLOWS_MCP_SKIP_MAIN !== "1") {
  main().catch((error) => {
    process.stderr.write(`[${SERVER_NAME}] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}

// Re-export for the contract suite.
export { buildManifest, TOOL_NAMES, annotationsForTool };
