import assert from "node:assert/strict";
import test from "node:test";
import { applyHiddenFilter, ToolVisibilityClient } from "../src/tool-visibility.js";

function stubResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("default state is an empty hidden set (no behavior change)", () => {
  const client = new ToolVisibilityClient({
    baseUrl: "http://agent-platform.test",
    apiKey: "emp_test",
    connector: "workflows",
  });
  assert.equal(client.getHiddenCount(), 0);
  assert.equal(client.isHidden("workflows_list"), false);
});

test("refresh populates the hidden set from the hidden-public endpoint", async () => {
  const client = new ToolVisibilityClient({
    baseUrl: "http://agent-platform.test",
    apiKey: "emp_test",
    connector: "workflows",
  });
  let calledUrl = "";
  let calledAuth = "";
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calledUrl = String(input);
    calledAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    return stubResponse({ tools: ["workflows_delete", "workflows_create"] });
  };
  try {
    const changed = await client.refresh();
    assert.equal(changed, true);
    assert.equal(calledUrl, "http://agent-platform.test/v1/tool-visibility/hidden-public?connector=workflows");
    assert.equal(calledAuth, "Bearer emp_test");
    assert.equal(client.getHiddenCount(), 2);
    assert.equal(client.isHidden("workflows_delete"), true);
    assert.equal(client.isHidden("workflows_list"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("refresh fails open on network error — existing set kept", async () => {
  const client = new ToolVisibilityClient({
    baseUrl: "http://agent-platform.test",
    apiKey: "emp_test",
    connector: "workflows",
  });
  client.setHiddenForTest(["workflows_delete"]);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("connection refused"); };
  try {
    const changed = await client.refresh();
    assert.equal(changed, false);
    assert.equal(client.getHiddenCount(), 1);
    assert.equal(client.isHidden("workflows_delete"), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("refresh fails open on non-2xx — existing set kept", async () => {
  const client = new ToolVisibilityClient({
    baseUrl: "http://agent-platform.test",
    apiKey: "emp_test",
    connector: "workflows",
  });
  client.setHiddenForTest(["workflows_delete"]);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("oops", { status: 503 });
  try {
    const changed = await client.refresh();
    assert.equal(changed, false);
    assert.equal(client.getHiddenCount(), 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("refresh is a no-op when baseUrl is empty (agent-platform not configured)", async () => {
  const client = new ToolVisibilityClient({
    baseUrl: "",
    apiKey: "",
    connector: "workflows",
  });
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return stubResponse({ tools: [] }); };
  try {
    const changed = await client.refresh();
    assert.equal(changed, false);
    assert.equal(calls, 0);
    assert.equal(client.getHiddenCount(), 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("onChange listeners fire when the set changes", async () => {
  const client = new ToolVisibilityClient({
    baseUrl: "http://agent-platform.test",
    apiKey: "k",
    connector: "workflows",
  });
  let calls = 0;
  let lastSize = -1;
  client.onChange((set) => { calls++; lastSize = set.size; });
  const original = globalThis.fetch;
  globalThis.fetch = async () => stubResponse({ tools: ["a", "b", "c"] });
  try {
    await client.refresh();
    assert.equal(calls, 1);
    assert.equal(lastSize, 3);
    // No-op when set hasn't changed.
    await client.refresh();
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("applyHiddenFilter disables tools matching the hidden set, enables others", () => {
  const client = new ToolVisibilityClient({
    baseUrl: "http://agent-platform.test",
    apiKey: "k",
    connector: "workflows",
  });
  client.setHiddenForTest(["workflows_delete"]);

  const tools: Record<string, { enabled: boolean; enable: () => void; disable: () => void }> = {
    "workflows_list": {
      enabled: true,
      enable() { this.enabled = true; },
      disable() { this.enabled = false; },
    },
    "workflows_delete": {
      enabled: true,
      enable() { this.enabled = true; },
      disable() { this.enabled = false; },
    },
  };
  const fakeServer = { _registeredTools: tools };
  applyHiddenFilter(fakeServer, client);
  assert.equal(tools["workflows_list"]!.enabled, true);
  assert.equal(tools["workflows_delete"]!.enabled, false);

  // Re-enable when the hidden set clears.
  client.setHiddenForTest([]);
  applyHiddenFilter(fakeServer, client);
  assert.equal(tools["workflows_list"]!.enabled, true);
  assert.equal(tools["workflows_delete"]!.enabled, true);
});

test("applyHiddenFilter is a safe no-op against an object without _registeredTools", () => {
  const client = new ToolVisibilityClient({
    baseUrl: "http://agent-platform.test",
    apiKey: "k",
    connector: "workflows",
  });
  // Must not throw.
  applyHiddenFilter({}, client);
  applyHiddenFilter(null, client);
});
