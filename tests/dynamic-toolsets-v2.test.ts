/**
 * v2 dynamic-toolsets smoke tests for workflows-mcp.
 *
 * Doesn't spin up a real MCP server — that pulls HTTP transport + employee-api
 * + agent-platform + pgvector shims and bloats unit-test scope. Instead we
 * feed a fake server with the workflows-mcp tool universe (6 workflow tools +
 * 3 v2 meta-tools) into a fresh DynamicToolsetV2Controller and exercise the
 * two behaviours that matter:
 *
 *   1. search_tools("read a playbook") returns workflows_read as a hit
 *   2. describe_tools flips revealed tools to enabled + emits list_changed
 */

import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";

import {
  DynamicToolsetV2Controller,
  META_TOOL_SCHEMAS_V2,
} from "@mediadevoted/mcp-passthrough/dynamic-toolsets-v2";

import { TOOLS_MANIFEST } from "../src/manifest.ts";

// Activate v2 dynamic toolsets for the duration of the tests. The controller's
// applyToSession is a no-op unless one of the env flags below is set.
const ORIGINAL_V2 = process.env.MCP_DYNAMIC_TOOLSETS_V2;
const ORIGINAL_V1 = process.env.MCP_DYNAMIC_TOOLSETS;

beforeEach(() => {
  process.env.MCP_DYNAMIC_TOOLSETS_V2 = "1";
  delete process.env.MCP_DYNAMIC_TOOLSETS;
});

afterEach(() => {
  if (ORIGINAL_V2 === undefined) delete process.env.MCP_DYNAMIC_TOOLSETS_V2;
  else process.env.MCP_DYNAMIC_TOOLSETS_V2 = ORIGINAL_V2;
  if (ORIGINAL_V1 === undefined) delete process.env.MCP_DYNAMIC_TOOLSETS;
  else process.env.MCP_DYNAMIC_TOOLSETS = ORIGINAL_V1;
});

// -----------------------------------------------------------------------------
// Fixtures — fake MCP server with the same tool universe workflows-mcp registers
// -----------------------------------------------------------------------------

type FakeTool = {
  name: string;
  enabled: boolean;
  description?: string;
  _meta?: Record<string, unknown>;
  enable: () => void;
  disable: () => void;
};

function fakeTool(name: string, toolset: string | null, description = ""): FakeTool {
  const meta: Record<string, unknown> = {};
  if (toolset) meta.toolset = toolset;
  const t: FakeTool = {
    name,
    enabled: true,
    description,
    _meta: Object.keys(meta).length > 0 ? meta : undefined,
    enable() {
      t.enabled = true;
    },
    disable() {
      t.enabled = false;
    },
  };
  return t;
}

type FakeServer = {
  _registeredTools: Record<string, FakeTool>;
  sendToolListChanged: () => void;
  notifyCount: number;
};

function buildFakeServer(): FakeServer {
  const tools: Record<string, FakeTool> = {};

  // The three v2 meta-tools — _default bucket via setToolsetOverride below.
  for (const meta of [
    META_TOOL_SCHEMAS_V2.search_tools.name,
    META_TOOL_SCHEMAS_V2.describe_tools.name,
    META_TOOL_SCHEMAS_V2.execute_tool.name,
  ]) {
    tools[meta] = fakeTool(meta, "_default", `meta ${meta}`);
  }

  // The 6 workflows-mcp tools — all tagged into the single "workflows" bucket.
  for (const entry of TOOLS_MANIFEST) {
    tools[entry.name] = fakeTool(entry.name, "workflows", entry.description);
  }

  const server: FakeServer = {
    _registeredTools: tools,
    notifyCount: 0,
    sendToolListChanged() {
      server.notifyCount++;
    },
  };
  return server;
}

function pinDefaults(controller: DynamicToolsetV2Controller): void {
  for (const name of [
    META_TOOL_SCHEMAS_V2.search_tools.name,
    META_TOOL_SCHEMAS_V2.describe_tools.name,
    META_TOOL_SCHEMAS_V2.execute_tool.name,
  ]) {
    controller.setToolsetOverride(name, "_default");
  }
}

// -----------------------------------------------------------------------------
// search_tools — "read a workflow playbook" surfaces workflows_read
// -----------------------------------------------------------------------------

test("search_tools('read a workflow playbook') returns workflows_read as a hit", () => {
  const controller = new DynamicToolsetV2Controller({ serverLabel: "workflows MCP" });
  pinDefaults(controller);
  const server = buildFakeServer();

  // BM25 ranks on description text. workflows_read's description begins with
  // "Read a single workflow's bodyMarkdown plus any prerequisite workflows".
  const hits = controller.search(server as unknown as object, "read a workflow playbook", 10);
  assert.ok(hits.length > 0, "search returned no hits");

  const hitNames = hits.map((h) => h.name);
  assert.ok(
    hitNames.includes("workflows_read"),
    `expected workflows_read in hits — got ${JSON.stringify(hitNames)}`,
  );
});

// -----------------------------------------------------------------------------
// describe_tools — enables hidden tools + emits list_changed
// -----------------------------------------------------------------------------

test("describe_tools enables a previously-hidden tool and emits list_changed once", () => {
  const controller = new DynamicToolsetV2Controller({ serverLabel: "workflows MCP" });
  pinDefaults(controller);
  const server = buildFakeServer();

  // Apply the session filter — hides every non-_default tool.
  const sessionId = "session-1";
  const hidden = controller.applyToSession(server as unknown as object, sessionId);
  assert.ok(hidden > 0, "applyToSession hid zero tools — bucket filter broken");

  // Pick workflows_read (in the "workflows" bucket) to reveal.
  const targetName = "workflows_read";
  assert.equal(server._registeredTools[targetName].enabled, false, "tool should be hidden pre-describe");

  const notifyBefore = server.notifyCount;
  const out = controller.describe(server as unknown as object, sessionId, [targetName]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.name, targetName);
  assert.equal(server._registeredTools[targetName].enabled, true, "describe_tools should re-enable the tool");
  assert.equal(
    server.notifyCount - notifyBefore,
    1,
    `expected exactly one sendToolListChanged after describe (got ${server.notifyCount - notifyBefore})`,
  );
});
