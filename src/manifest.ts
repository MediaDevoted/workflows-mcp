/**
 * Workflows-mcp tool manifest. Single source of truth for
 * `(permission_key, description, annotations)` per tool. The catalog-sync
 * boot step reads this; `runMcpServer` re-reads it to render
 * `<connector>://tools-manifest`.
 *
 * Adding a tool requires adding an entry here.
 *
 * Description style (5-section template): rich, intent-first prose that
 * gives Hermes enough signal to pick the right tool first try without
 * consulting SOUL.md every turn. Sections:
 *   1. Lead sentence — what the tool DOES and the right human ask
 *   2. ARGS — typed list with examples
 *   3. RESPONSE — shape and key fields
 *   4. WHEN TO USE / ANTI-PATTERNS — routing signal
 *   5. EXAMPLE — a worked call
 */

import { buildManifestPayload, type ToolAnnotations, type ToolManifestEntry, type ToolManifestPayload } from "@mediadevoted/mcp-passthrough/catalog-sync";

export const CONNECTOR = "workflows";
export const CONNECTOR_KEY = "WORKFLOWS";

export function toolPermissionKey(toolName: string): string {
  const upper = toolName.toUpperCase();
  if (upper.startsWith(`${CONNECTOR_KEY}_`)) {
    return `${CONNECTOR_KEY}_TOOL_${upper.slice(CONNECTOR_KEY.length + 1)}`;
  }
  return `${CONNECTOR_KEY}_TOOL_${upper}`;
}

interface ToolMeta {
  description: string;
  annotations: ToolAnnotations;
}

/**
 * Short descriptions for the catalog-sync manifest (capped at 200 chars by the
 * caller). The rich, multi-section descriptions live in `RICH_DESCRIPTIONS`
 * below and are surfaced via `descriptionForTool` for in-process tool
 * registration. The manifest description stays terse so the
 * `<connector>://tools-manifest` listing reads cleanly in the dashboard.
 */
const TOOL_META: Record<string, ToolMeta> = {
  workflows_status: {
    description: "Connector health and safety status for workflows-mcp.",
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  workflows_list: {
    description: "List workflow playbooks visible to the caller. Optional filters: connector, assignedRole, search.",
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  workflows_search: {
    description: "Semantic search over workflow playbooks via OpenAI embeddings + pgvector. Accepts mode='fast'|'deep'.",
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  workflows_read: {
    description: "Read a single workflow's bodyMarkdown plus any prerequisite workflows (mustReadBefore).",
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  workflows_create: {
    description: "Create a new workflow playbook. Requires MANAGE_WORKFLOWS.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  workflows_update: {
    description: "Update an existing workflow playbook (slug is immutable). Requires MANAGE_WORKFLOWS.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  workflows_delete: {
    description: "Delete a workflow playbook. DESTRUCTIVE — requires confirm=true and MANAGE_WORKFLOWS.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
};

/**
 * Rich, multi-section descriptions used at tool-registration time. These are
 * the prose Hermes actually sees in `tools/list` and `describe_tools`. They
 * follow the same 5-section template used in voluum/cloudflare/blast/namecheap
 * MCPs so the operator-facing surface is consistent across the fleet.
 *
 * Hard rule baked into every read description: workflows BEAT memory. The
 * operator-curated playbook is authoritative — agents must follow it verbatim,
 * not improvise from training data or earlier conversation context.
 */
const RICH_DESCRIPTIONS: Record<string, string> = {
  workflows_status: `Connector health for workflows-mcp. Returns whether agent-platform is reachable, whether audit-trail is wired, whether semantic-search embeddings are ready, and the employee-api auth mode. Smoke probe — use to confirm the connector is live before chasing routing bugs.

ARGS:
- (none)

RESPONSE:
{ok, data: {connector: "workflows", version, agent_platform_configured: bool, audit_trail_configured: bool, auth_disabled: bool, embeddings_enabled: bool, embedded_query_dims: int}}. \`embeddings_enabled=false\` means workflows_search degrades to literal trigger ranking (still works, just less semantic).

WHEN TO USE:
- "is the workflows MCP up"
- "why is workflows_search returning no results" — check \`embeddings_enabled\`
- pre-flight before a long automated run that depends on the workflow catalog

ANTI-PATTERNS:
- Do NOT call this on every turn. It's a smoke probe, not a routing tool.
- Do NOT use this to look up workflows — use workflows_list or workflows_search.

EXAMPLE:
User: "is workflows-mcp healthy"
Call: workflows_status({})
Then: read data.agent_platform_configured (true means the upstream is wired) and data.embeddings_enabled (true means semantic search is on).`,

  workflows_list: `List operator-curated workflow playbooks visible to the caller. Each row is a slug + title + description + triggers + connectors + assignedRoles. Use this when you know the connector/role you care about and want to enumerate playbooks. For free-text discovery prefer workflows_search.

PHILOSOPHY: workflows BEAT memory. If a playbook exists for the task, follow it verbatim — do not improvise from training data. Operators have validated the sequence of steps; skipping steps because they "look redundant" is the most common cross-connector outage cause.

ARGS:
- connector?: string — filter by connector tag. Example: "namecheap", "cloudflare", "voluum", "blast".
- assignedRole?: string — filter to playbooks assigned to a specific role key. Example: "smslord", "campaign-manager".
- search?: string — free-text substring forwarded to agent-platform's listing endpoint (NOT semantic — use workflows_search for that).

RESPONSE:
{ok, data: {count: N, workflows: [{slug, title, description, triggers, connectors, assignedRoles}], filters: {connector, assignedRoles, search}}}. \`assignedRoles=[]\` means admin-only. Empty \`workflows\` array means no visible playbooks match — fall back to your normal reasoning, do NOT invent a workflow.

WHEN TO USE:
- "what playbooks do we have for cloudflare" → connector="cloudflare"
- "list workflows for the SMS team" → assignedRole="smslord"
- "do we have a runbook for X" — list + scan client-side, or call workflows_search
- Routing pre-step when the user asks anything procedural ("how do I rotate domains", "what's the launch process")

ANTI-PATTERNS:
- Do NOT call this for a single-step data lookup ("what's my Namecheap balance") — that's a direct connector call, not a workflow.
- Do NOT enumerate workflows then sit on them — pair this with workflows_read to actually pull the body of the chosen playbook.
- Do NOT call workflows_list on every turn — it's a discovery tool, not a status probe.

EXAMPLE:
User: "show me cloudflare playbooks"
Call: workflows_list({connector: "cloudflare"})
Then: pick the most relevant {slug, title}; call workflows_read({slug}) for the full markdown.`,

  workflows_search: `Semantic search over the workflow catalog via OpenAI embeddings + pgvector cosine similarity. Returns top-K ranked hits with title/description/triggers. Falls back to literal trigger/title/description ranking if embeddings are unavailable (returns \`degraded=true\` in that case). This is the right tool when the user describes a task in their own words ("revalidate the domain", "onboard a new partner", "rotate to fresh IPs") and you don't know which playbook covers it.

PHILOSOPHY: procedural intents — "revalidate", "onboard", "rotate", "audit", "launch", "cutover", "retest", "migrate" — should ALWAYS hit workflows_search first. Workflows BEAT memory. Operator-curated playbooks have validated the exact step sequence; improvising from training data is how cross-connector outages happen. DO NOT skip steps even if they "look redundant" — operators validated the redundancy too.

ARGS:
- query: string required — natural-language description of the task. Example: "rotate domain to cloudflare", "launch a new SMS campaign", "auto-zero offers at cap".
- limit?: int 1..20 — max hits. Default 5. Bump to 10 when the search returns ambiguous matches.
- mode?: "fast" | "deep" — "fast" (default) ranks on title/description/triggers; "deep" blends in the full body markdown for cases where the right playbook is identified by step content rather than title.

RESPONSE:
{ok, data: {query, mode, total_visible: N, returned: M, results: [{slug, title, description, score, matched_triggers?}], embedded_query_dims?, degraded?: bool}}. When \`degraded=true\`, embeddings were unavailable and the ranking is literal trigger/title/description matching — still useful, but exact-phrase wording matters more. \`score\` is the cosine similarity (0-1) when embeddings are on, or an integer trigger-match score when degraded.

WHEN TO USE:
- "how do I rotate domains" / "revalidate this campaign" / "onboard partner X" — any procedural intent
- "what's the playbook for cutting over a shortlink fleet"
- When workflows_list with a connector filter returns too many results to scan
- When the user uses ops vocabulary ("audit", "retest", "auto-zero", "smoke test") — these almost always map to a playbook

ANTI-PATTERNS:
- DATA LOOKUPS go to connector MCPs, not workflows. "List campaigns" → voluum, "list DNS records" → cloudflare. workflows_search is for HOW-TO, not WHAT-IS.
- Do NOT improvise multi-step ops without searching first. If workflows_search returns a hit (any non-zero score), READ it before acting.
- Do NOT bail just because the top hit has a lower score than you expected. Call workflows_read on the top 2-3 hits and pick the one whose triggers match.
- Do NOT translate the user's question into a tool-specific query ("list voluum offers"). Use the user's own task vocabulary ("auto-zero offers at cap").

EXAMPLE:
User: "rotate the shortlink fleet to fresh IPs"
Call: workflows_search({query: "rotate shortlink to fresh IPs"})
Then: data.results[0].slug is the most likely playbook. Call workflows_read({slug}) to pull the full body. Follow the steps verbatim.`,

  workflows_read: `Read a single workflow's full bodyMarkdown plus any prerequisite playbooks (\`mustReadBefore\`). The bodyMarkdown is the authoritative runbook — its steps are what you execute, in order, without skipping or reordering. Prerequisites are auto-pulled; read THEM FIRST then the main workflow body.

PHILOSOPHY: this is the critical operator boundary. Once you have a workflow body, FOLLOW IT VERBATIM. Operators have validated:
- the order of steps (don't reorder)
- the inclusion of every step (don't skip — "looks redundant" is a trap)
- the specific tool calls to make and their arguments (don't substitute "equivalent" calls)
- the validation gates (don't bypass dry-run / confirm requirements)
If a step seems wrong, STOP and ask the operator. Do NOT improvise.

ARGS:
- slug: string required — workflow slug from workflows_list / workflows_search results. Lowercase kebab-case. Example: "rotate-namecheap-domain".

RESPONSE:
{ok, data: {workflow: {slug, title, description, bodyMarkdown, triggers, connectors, assignedRoles}, prerequisites: [{slug, title, bodyMarkdown}], instructions: "Read prerequisites first, then the main workflow."}}. \`prerequisites\` is the array of \`mustReadBefore\` workflows — ALWAYS read those first; they exist because the main workflow assumes that context. \`instructions\` is the literal ordering directive (read prerequisites → read main → execute). \`workflow.assignedRoles=[]\` means the workflow is admin-only.

WHEN TO USE:
- After workflows_search or workflows_list — pull the body of the chosen playbook
- "give me the runbook for X" / "what's the procedure for Y"
- Re-reading a known workflow before a high-stakes execution (do not rely on memory — the workflow may have been updated)

ANTI-PATTERNS:
- Do NOT skip prerequisites because they look unrelated — they're listed because the main body depends on them.
- Do NOT execute the workflow steps in parallel unless the body explicitly says so — sequential by default.
- Do NOT paraphrase the workflow steps to the user before executing. Either follow them or stop and explain WHY you can't.
- Do NOT call workflows_read multiple times for the same slug in one task — cache the body in your working context.
- Do NOT modify the steps. If a step's arguments need to change for this caller, surface that to the operator — don't silently adapt.

EXAMPLE:
User: "rotate namecheap-prime.com to cloudflare"
Sequence:
1. workflows_search({query: "rotate namecheap to cloudflare"}) → finds slug "rotate-namecheap-domain"
2. workflows_read({slug: "rotate-namecheap-domain"}) → pulls body + prerequisites
3. Read prerequisites first (e.g. "cloudflare-account-setup"), then the main workflow
4. Execute steps verbatim — each step tells you which other MCP to call`,

  workflows_create: `Create a new workflow playbook in the operator catalog. The bodyMarkdown becomes the authoritative runbook future agents will execute. Mutation requires \`MANAGE_WORKFLOWS\` and \`confirm=true\`. Use \`dry_run=true\` to validate inputs without dispatching. Authoring workflows is OPERATOR work — agents should rarely call this without an operator's explicit hand-off.

ARGS:
- slug: string required — lowercase kebab-case identifier. Example: "rotate-namecheap-domain". Cannot be changed after creation.
- title: string required — human-readable title shown in lists. Example: "Rotate a Namecheap domain to Cloudflare".
- bodyMarkdown: string required — the runbook itself. Markdown body that future agents will execute verbatim. Be precise about tool names, argument shapes, ordering, and validation gates.
- description?: string — one-line summary alongside the title in lists.
- triggers?: string[] — short trigger phrases for prompt search. Example: ["rotate domain", "move to cloudflare", "namecheap to cloudflare"].
- connectors?: string[] — connector keys this workflow uses. Example: ["namecheap", "cloudflare"]. Drives the \`connector\` filter on workflows_list.
- mustReadBefore?: string[] — slugs of prerequisite workflows auto-pulled when this one is read. Example: ["cloudflare-account-setup"].
- assignedRoles?: string[] — role keys that may read this workflow. Empty array = admin-only.
- dry_run?: bool — when true, validate inputs but skip dispatch. Returns the proposed body for review.
- confirm: bool required for live — must be true to dispatch.
- approval_note?: string — human-readable rationale recorded in the audit row.

RESPONSE:
On dry_run: {ok, data: {dry_run: true, would_create: {slug, title, description, assignedRoles}}}.
On live: {ok, data: {slug}}. Slug is lowercased.
On error: {ok: false, error: {code: "DENIED" | "VALIDATION" | "UPSTREAM_HTTP", ...}}.

WHEN TO USE:
- Operator hand-off: "save this as a workflow called rotate-namecheap-domain"
- Codifying a procedure the operator just walked through manually
- Only call when the operator EXPLICITLY asks. Do not preemptively create workflows because the conversation feels procedural.

ANTI-PATTERNS:
- Do NOT auto-create workflows mid-task. Operators own the catalog.
- Do NOT create a workflow whose body you wouldn't trust another agent to execute verbatim.
- Do NOT skip \`triggers\` — without triggers, workflows_search can't find the workflow.
- Do NOT use empty \`assignedRoles\` unless the workflow is genuinely admin-only.
- Do NOT call this without dry_run first to verify the body renders correctly.

EXAMPLE:
User: "save this as a workflow called rotate-namecheap-domain"
Call (dry_run first):
workflows_create({slug: "rotate-namecheap-domain", title: "Rotate a Namecheap domain to Cloudflare", bodyMarkdown: "...full runbook...", triggers: ["rotate domain","move to cloudflare"], connectors: ["namecheap","cloudflare"], assignedRoles: ["smslord","admin"], dry_run: true})
Then on operator confirm:
workflows_create({...same, dry_run: false, confirm: true, approval_note: "operator request"})`,

  workflows_update: `Update an existing workflow's title / body / triggers / connectors / assignedRoles. Slug is immutable — to rename, delete + create. Requires \`MANAGE_WORKFLOWS\` and \`confirm=true\`. Use \`dry_run=true\` to validate inputs without dispatching.

PHILOSOPHY: updates to a workflow change what FUTURE agents will execute. Treat edits as authoritative — once the playbook is updated, downstream agents will follow the new version. Keep triggers stable across edits to avoid breaking cross-MCP discovery.

ARGS:
- slug: string required — workflow slug to update. Lowercase kebab-case. Cannot be changed.
- title: string required — updated title.
- bodyMarkdown: string required — updated runbook body. Full body, NOT a diff. Use workflows_read first to fetch the current body, then edit, then submit the full result.
- description?: string — updated one-line summary.
- triggers?: string[] — updated trigger phrases. Keep stable for prompt-search continuity.
- connectors?: string[] — updated connector tags.
- mustReadBefore?: string[] — updated prerequisite slugs.
- assignedRoles?: string[] — updated role visibility. Empty array narrows to admin-only.
- dry_run?: bool — validate without dispatching.
- confirm: bool required for live — must be true.
- approval_note?: string — recorded in audit row.

RESPONSE:
On dry_run: {ok, data: {dry_run: true, would_update: {slug, title, description}}}.
On live: {ok, data: {slug}}.
On error: {ok: false, error: {code: "NOT_FOUND" | "DENIED" | "VALIDATION" | "UPSTREAM_HTTP", ...}}.

WHEN TO USE:
- Operator hand-off: "update the rotate-namecheap-domain workflow to also handle the bulk case"
- Codifying a learned exception that came up mid-execution
- Re-tagging connectors when a workflow's scope expands

ANTI-PATTERNS:
- Do NOT update workflows mid-task to "fix" a perceived issue. Surface the issue to the operator.
- Do NOT submit a partial body — the API replaces the full body. Always workflows_read first.
- Do NOT change the slug — it's immutable; the API will reject it.
- Do NOT rename triggers without operator sign-off — breaks discovery for other agents.

EXAMPLE:
User: "update rotate-namecheap-domain to mention the new nameserver pair"
Sequence:
1. workflows_read({slug: "rotate-namecheap-domain"}) → fetch current body
2. Operator edits the body OR you propose changes for review
3. workflows_update({slug: "rotate-namecheap-domain", title: "...", bodyMarkdown: "<full updated body>", triggers: [...], confirm: true, approval_note: "operator request"})`,

  workflows_delete: `Delete a workflow playbook. DESTRUCTIVE — requires \`confirm=true\` AND \`MANAGE_WORKFLOWS\` permission. Use \`dry_run=true\` to preview. Once deleted, agents lose the runbook and may improvise — only delete when the workflow is explicitly retired or replaced.

ARGS:
- slug: string required — workflow slug to delete.
- dry_run?: bool — validate without dispatching. Returns the slug that would be deleted.
- confirm: bool required for live — must be true. Forces explicit second-step confirmation.
- approval_note: string — rationale recorded in the audit row. Strongly recommended for deletes.

RESPONSE:
On dry_run: {ok, data: {dry_run: true, would_delete: slug}}.
On live: {ok, data: {deleted: slug}} (slug lowercased).
On error: {ok: false, error: {code: "NOT_FOUND" | "DENIED" | "UPSTREAM_HTTP", ...}}.

WHEN TO USE:
- Operator-driven retirement: "delete the legacy rotate-namecheap-domain workflow — we use rotate-domain-v2 now"
- Cleanup of a workflow that was demonstrably wrong and is being replaced

ANTI-PATTERNS:
- Do NOT delete a workflow because it's "outdated" without confirming with the operator. The catalog is authoritative; you might be the one with stale info.
- Do NOT delete workflows mid-task to "clean up" — that's an operator decision.
- Do NOT skip \`approval_note\` — audit trails are how the operator reconstructs what happened.
- Do NOT delete a workflow that's referenced by another workflow's \`mustReadBefore\` — break the dependency first.

EXAMPLE:
User: "delete the legacy rotate-namecheap-domain workflow"
Sequence:
1. workflows_read({slug: "rotate-namecheap-domain"}) → confirm contents with operator
2. workflows_delete({slug: "rotate-namecheap-domain", dry_run: true, approval_note: "replaced by rotate-domain-v2"}) → preview
3. workflows_delete({slug: "rotate-namecheap-domain", confirm: true, approval_note: "replaced by rotate-domain-v2"}) → live delete`,
};

export function annotationsForTool(toolName: string): ToolAnnotations {
  return TOOL_META[toolName]?.annotations ?? { readOnlyHint: false };
}

export function descriptionForTool(toolName: string): string {
  return RICH_DESCRIPTIONS[toolName] ?? TOOL_META[toolName]?.description ?? toolName;
}

/**
 * Catalog-sync description — short form, capped at 200 chars by the caller.
 * Used by the agent-platform tools-manifest endpoint and the dashboard's
 * catalog index. Distinct from `descriptionForTool` (the rich, multi-section
 * tool-registration description).
 */
export function shortDescriptionForTool(toolName: string): string {
  return TOOL_META[toolName]?.description ?? toolName;
}

export const TOOL_NAMES: readonly string[] = Object.freeze([
  "workflows_status",
  "workflows_list",
  "workflows_search",
  "workflows_read",
  "workflows_create",
  "workflows_update",
  "workflows_delete",
]);

export function buildToolManifestEntries(): ToolManifestEntry[] {
  return TOOL_NAMES.map((name) => {
    const meta = TOOL_META[name];
    if (!meta) throw new Error(`buildToolManifestEntries: missing TOOL_META entry for ${name}`);
    const requiresApproval = meta.annotations.destructiveHint === true || meta.annotations.readOnlyHint !== true;
    return {
      name,
      permission_key: toolPermissionKey(name),
      description: meta.description,
      annotations: meta.annotations,
      requires_approval: requiresApproval,
    };
  });
}

export function buildWorkflowsManifest(adminPermissions: string[], readPermission: string, writePermission: string): ToolManifestPayload {
  return buildManifestPayload({
    connector: CONNECTOR,
    connectorKey: CONNECTOR_KEY,
    permissionKeys: {
      admin: adminPermissions,
      read: [readPermission],
      write: [writePermission],
      tool_prefix: `${CONNECTOR_KEY}_TOOL_`,
    },
    credentialsSchema: {
      // workflows-mcp is a thin RBAC-gated wrapper over agent-platform's
      // workflow store. There are no per-tenant credentials — the platform
      // resolves the caller via their employee-api key.
      fields: [],
    },
    tools: buildToolManifestEntries(),
  });
}
