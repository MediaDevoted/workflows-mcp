/**
 * Regression test for the `workflows_search` trim crash.
 *
 * Bug: mcp-passthrough's `execute_tool` meta-tool forwards args directly to the
 * underlying handler, bypassing the Zod schema. When Hermes called
 * `execute_tool({ name: "workflows_search", args: {} })`, the handler received
 * `query === undefined` and `scoreWorkflow` crashed on `query.trim()`.
 *
 * Fix: defensive coercion of `query` to a string in both `scoreWorkflow` and
 * the `workflows_search` handler. Exercising `scoreWorkflow` here pins the
 * inner crash. The handler-level guard is covered by tsc + a manual
 * smoke test via execute_tool from Hermes.
 */

import assert from "node:assert/strict";
import test from "node:test";

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
