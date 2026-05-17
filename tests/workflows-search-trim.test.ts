/**
 * Regression test for the `workflows_search` trim crash.
 *
 * Bug: mcp-passthrough's `execute_tool` meta-tool forwards args directly to the
 * underlying handler, bypassing the Zod schema. When Hermes called
 * `execute_tool({ name: "workflows_search", args: {} })`, the handler received
 * `query === undefined` and `scoreWorkflow` crashed on `query.trim()`.
 *
 * Fix: defensive coercion of `query` to a string in both `scoreWorkflow` and
 * the `workflows_search` handler. We pin BOTH the inner ranking helper and
 * the in-process handler entry — Hermes calls it via `execute_tool`, so the
 * handler-level guard is the critical one.
 */

// `npm test` sets EMPLOYEE_AUTH_DISABLED=true + AGENT_PLATFORM_URL + WORKFLOWS_MCP_SKIP_MAIN=1
// so the singleton identity client constructs in synthetic-admin mode and we
// don't spin up the HTTP transport. ES module imports are hoisted above any
// `process.env.X = "..."` assignment in the test file, so setting env vars here
// is too late.

import assert from "node:assert/strict";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWorkflowsTools } from "../src/index.ts";
import { scoreWorkflow } from "../src/ranking.ts";
import type { WorkflowSummary } from "../src/agent-platform.ts";

const fixture: WorkflowSummary = {
  slug: "rotate-namecheap-domain",
  title: "Rotate a Namecheap domain to Cloudflare",
  description: "Move a domain off Namecheap nameservers to Cloudflare.",
  triggers: ["rotate domain", "move to cloudflare"],
  connectors: ["namecheap", "cloudflare"],
  assignedRoles: [],
};

test("scoreWorkflow does not crash when query is undefined", () => {
  // Cast through unknown: this exercises the exact bypass path where
  // execute_tool hands the handler an args bag without a `query` key.
  const result = scoreWorkflow(fixture, undefined);
  assert.equal(result.slug, fixture.slug);
  assert.equal(result.score, 0);
  assert.deepEqual(result.matched_triggers, []);
});

test("scoreWorkflow does not crash when query is null", () => {
  const result = scoreWorkflow(fixture, null);
  assert.equal(result.score, 0);
  assert.deepEqual(result.matched_triggers, []);
});

test("scoreWorkflow does not crash when query is not a string", () => {
  const result = scoreWorkflow(fixture, 42);
  assert.equal(result.score, 0);
  assert.deepEqual(result.matched_triggers, []);
});

test("scoreWorkflow handles empty string without crashing", () => {
  const result = scoreWorkflow(fixture, "");
  assert.equal(result.score, 0);
  assert.deepEqual(result.matched_triggers, []);
});

test("scoreWorkflow still ranks real queries correctly", () => {
  const result = scoreWorkflow(fixture, "rotate domain");
  assert.ok(result.score > 0, "non-empty query should produce a positive score");
  assert.ok(result.matched_triggers.length > 0);
});

// -----------------------------------------------------------------------------
// Handler-level regression: the in-process `workflows_search` handler MUST NOT
// crash when called with an empty args object — Hermes hits this path through
// dynamic-toolsets-v2's `execute_tool`, which bypasses the Zod schema.
// -----------------------------------------------------------------------------

function buildServerWithWorkflowsTools(): McpServer {
  const server = new McpServer(
    { name: "workflows-mcp", version: "0.2.0-test" },
    { capabilities: { tools: {}, resources: {} } },
  );
  registerWorkflowsTools(server as unknown as Parameters<typeof registerWorkflowsTools>[0]);
  return server;
}

interface RegisteredHandler {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: { ok?: boolean; error?: { code?: string; message?: string } };
  }>;
}

function getRegisteredTool(server: McpServer, name: string): RegisteredHandler {
  const internal = server as unknown as { _registeredTools: Record<string, RegisteredHandler> };
  const tool = internal._registeredTools[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

test("workflows_search handler returns a graceful error for empty args (no crash)", async () => {
  const server = buildServerWithWorkflowsTools();
  const tool = getRegisteredTool(server, "workflows_search");
  // Empty args — mirrors `execute_tool({ name: "workflows_search", args: {} })`.
  const result = await tool.handler({}, { sessionId: "trim-test" });
  const text = result.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(text) as { ok?: boolean; error?: { code?: string } };
  assert.equal(parsed.ok, false, "handler should return ok:false instead of crashing");
  assert.equal(parsed.error?.code, "MISSING_PARAM");
});

test("workflows_search handler does not crash on non-string query", async () => {
  const server = buildServerWithWorkflowsTools();
  const tool = getRegisteredTool(server, "workflows_search");
  const result = await tool.handler({ query: 42, limit: "x" } as unknown as Record<string, unknown>, { sessionId: "trim-test" });
  const text = result.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(text) as { ok?: boolean; error?: { code?: string } };
  assert.equal(parsed.ok, false, "non-string query should not crash; should return ok:false");
  assert.equal(parsed.error?.code, "MISSING_PARAM");
});

test("workflows_search handler does not crash on null query", async () => {
  const server = buildServerWithWorkflowsTools();
  const tool = getRegisteredTool(server, "workflows_search");
  const result = await tool.handler({ query: null } as unknown as Record<string, unknown>, { sessionId: "trim-test" });
  const text = result.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(text) as { ok?: boolean };
  assert.equal(parsed.ok, false);
});
