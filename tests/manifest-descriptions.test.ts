/**
 * Manifest description tests — verify the rich 5-section descriptions are
 * wired up correctly and the short catalog-sync descriptions stay short.
 *
 * The runtime registers tools with `descriptionForTool(toolName)` — the rich
 * multi-section prose. The catalog-sync manifest uses `shortDescriptionForTool`
 * which is capped at 200 chars by the upstream. These are deliberately
 * separate so the dashboard catalog reads cleanly while the agent-facing
 * tool description gives Hermes the routing detail it needs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_NAMES,
  annotationsForTool,
  descriptionForTool,
  shortDescriptionForTool,
  buildToolManifestEntries,
} from "../src/manifest.ts";

test("every tool has a rich description (5-section template, >= 600 chars)", () => {
  for (const name of TOOL_NAMES) {
    const desc = descriptionForTool(name);
    assert.ok(
      desc.length >= 600,
      `descriptionForTool(${name}) is only ${desc.length} chars — expected the 5-section template (>= 600).`,
    );
    // Spot-check that the template sections exist.
    const upper = desc.toUpperCase();
    assert.ok(upper.includes("ARGS:"), `descriptionForTool(${name}) missing 'ARGS:' section`);
    assert.ok(upper.includes("RESPONSE:") || upper.includes("RESPONSE\n"), `descriptionForTool(${name}) missing 'RESPONSE' section`);
    // EXAMPLE section may not exist for status (smoke probe) — allow either.
  }
});

test("short manifest description stays under 200 chars", () => {
  for (const name of TOOL_NAMES) {
    const short = shortDescriptionForTool(name);
    assert.ok(
      short.length <= 200,
      `shortDescriptionForTool(${name}) is ${short.length} chars — agent-platform truncates at 200, keep it short.`,
    );
  }
});

test("rich read-tool descriptions mention 'workflows BEAT memory' or 'verbatim' for the routing principle", () => {
  // The whole point of the rich descriptions is to make agents follow
  // operator-curated playbooks instead of improvising. Spot-check the key
  // read tools surface that principle.
  for (const name of ["workflows_search", "workflows_read", "workflows_list"]) {
    const desc = descriptionForTool(name);
    const lower = desc.toLowerCase();
    const hasPrinciple =
      lower.includes("beat memory") ||
      lower.includes("verbatim") ||
      lower.includes("authoritative");
    assert.ok(
      hasPrinciple,
      `descriptionForTool(${name}) should anchor the "workflows beat memory / follow verbatim" principle`,
    );
  }
});

test("manifest entries pair description with permission key and annotations", () => {
  const entries = buildToolManifestEntries();
  assert.equal(entries.length, TOOL_NAMES.length, "one manifest entry per tool");
  for (const entry of entries) {
    assert.ok(entry.name, "entry.name set");
    assert.ok(entry.permission_key.startsWith("WORKFLOWS_TOOL_"), `entry.permission_key starts with WORKFLOWS_TOOL_ (got ${entry.permission_key})`);
    assert.ok(typeof entry.description === "string" && entry.description.length > 0, "entry.description non-empty");
    assert.ok(entry.description.length <= 200, "entry.description capped at 200 for catalog-sync");
    assert.ok(entry.annotations, "entry.annotations set");
  }
});

test("annotationsForTool: read tools are readOnlyHint:true; write tools are not", () => {
  for (const name of ["workflows_status", "workflows_list", "workflows_search", "workflows_read"]) {
    assert.equal(annotationsForTool(name).readOnlyHint, true, `${name} should be readOnlyHint:true`);
  }
  for (const name of ["workflows_create", "workflows_update", "workflows_delete"]) {
    assert.notEqual(annotationsForTool(name).readOnlyHint, true, `${name} should NOT be readOnlyHint:true`);
  }
  assert.equal(annotationsForTool("workflows_delete").destructiveHint, true, "workflows_delete is destructive");
});
