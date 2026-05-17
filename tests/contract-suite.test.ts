/**
 * Workflows MCP contract suite gate.
 *
 * Builds an in-process MCP server (no transport, no subprocess), wraps it
 * with a thin "direct" client satisfying `ContractMcpClient` by reading
 * `_registeredTools`/`_registeredResources` and invoking handlers directly,
 * then runs the shared fleet contract suite. CI fails if any check fails.
 */

// `npm test` sets EMPLOYEE_AUTH_DISABLED=true + AGENT_PLATFORM_URL + WORKFLOWS_MCP_SKIP_MAIN=1
// so the singleton identity client constructs in synthetic-admin mode and we
// don't spin up the HTTP transport.

import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  runContractSuite,
  formatContractSuiteSummary,
  DynamicToolsetV2Controller,
  META_TOOL_SCHEMAS_V2,
  registerCommonResources,
  type ContractMcpClient,
  type ContractMcpTool,
} from "@mediadevoted/mcp-passthrough";

import { buildManifest, registerWorkflowsTools, TOOL_NAMES } from "../src/index.ts";

/**
 * Build a "direct" MCP client that satisfies `ContractMcpClient` without
 * going through transports. The contract suite only needs initialize /
 * listTools / callTool / readResource / close.
 */
function buildDirectClient(server: McpServer, instructions: string): ContractMcpClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internal = server as unknown as {
    _registeredTools: Record<string, {
      description?: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
      _meta?: Record<string, unknown>;
      handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
    }>;
    _registeredResources: Record<string, {
      metadata?: { uri?: string; mimeType?: string };
      readCallback: () => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>;
    }>;
  };

  return {
    async initialize() {
      return {
        serverInfo: { name: "workflows-mcp", version: "0.2.0" },
        instructions,
      };
    },
    async listTools() {
      const tools: ContractMcpTool[] = Object.entries(internal._registeredTools).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        _meta: tool._meta,
      }));
      return { tools };
    },
    async callTool(name, args) {
      const tool = internal._registeredTools[name];
      if (!tool) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: `unknown_tool:${name}` }) }],
        };
      }
      const result = (await tool.handler(args ?? {}, { sessionId: "contract-suite" })) as {
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: unknown;
        isError?: boolean;
      };
      return {
        content: result.content,
        structuredContent: result.structuredContent,
        isError: result.isError,
      };
    },
    async readResource(uri) {
      for (const entry of Object.values(internal._registeredResources)) {
        const declaredUri = entry.metadata?.uri;
        if (declaredUri === uri) return entry.readCallback();
      }
      const direct = internal._registeredResources[uri];
      if (direct) return direct.readCallback();
      throw new Error(`unknown_resource:${uri}`);
    },
    async close() {
      // no-op
    },
  };
}

test("contract-suite: workflows-mcp passes every fleet check", async () => {
  const instructions = "workflows-mcp contract-suite test instance";
  const server = new McpServer(
    { name: "workflows-mcp", version: "0.2.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions,
    },
  );

  // Workflow tools.
  registerWorkflowsTools(server as unknown as Parameters<typeof registerWorkflowsTools>[0]);

  // Common resources.
  registerCommonResources(
    server as unknown as Parameters<typeof registerCommonResources>[0],
    "workflows",
    {
      overview: "# workflows-mcp\nContract-suite test overview.",
      safety: "# workflows safety\nContract-suite test safety doc.",
      operatorPlaybook: "# workflows playbook\nContract-suite test playbook.",
    },
    () => buildManifest(),
  );

  // v2 meta-tools — register the same way `runMcpServer` does at the runtime
  // layer. We register them in-process so the contract suite finds them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registerMetaTool = (server as any).registerTool.bind(server) as (
    name: string,
    config: Record<string, unknown>,
    handler: (...args: unknown[]) => unknown,
  ) => unknown;
  const controller = new DynamicToolsetV2Controller({ serverLabel: "workflows MCP" });
  for (const name of TOOL_NAMES) controller.setToolsetOverride(name, "workflows");
  for (const meta of [
    META_TOOL_SCHEMAS_V2.search_tools,
    META_TOOL_SCHEMAS_V2.describe_tools,
    META_TOOL_SCHEMAS_V2.execute_tool,
  ]) {
    controller.setToolsetOverride(meta.name, "_default");
  }

  registerMetaTool(
    META_TOOL_SCHEMAS_V2.search_tools.name,
    {
      description: controller.renderSearchToolDescription(server as unknown),
      inputSchema: {},
    },
    async (args: Record<string, unknown>) => {
      const query = String(args.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "query_required" }) }] };
      }
      const limit = typeof args.limit === "number" ? args.limit : 10;
      const hits = controller.search(server as unknown, query, limit);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, query, count: hits.length, results: hits }) }],
      };
    },
  );
  registerMetaTool(
    META_TOOL_SCHEMAS_V2.describe_tools.name,
    { description: META_TOOL_SCHEMAS_V2.describe_tools.description, inputSchema: {} },
    async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ ok: true, tools: [] }) }] }),
  );
  registerMetaTool(
    META_TOOL_SCHEMAS_V2.execute_tool.name,
    { description: META_TOOL_SCHEMAS_V2.execute_tool.description, inputSchema: {} },
    async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] }),
  );

  const client = buildDirectClient(server, instructions);
  const result = await runContractSuite({
    spawn: async () => client,
    connector: "workflows",
    // 7 workflow tools + 3 v2 meta-tools = 10 minimum.
    expectedMinTools: TOOL_NAMES.length + 3,
  });

  if (result.failed > 0) {
    throw new Error(`contract-suite failed (${result.failed}/${result.total}):\n${formatContractSuiteSummary(result)}`);
  }

  assert.equal(result.passed, result.total, `expected all checks to pass, got ${result.passed}/${result.total}`);
});
