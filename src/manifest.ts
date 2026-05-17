/**
 * Workflows-mcp tool manifest. Single source of truth for
 * `(permission_key, description, annotations)` per tool. The catalog-sync
 * boot step reads this; `runMcpServer` re-reads it to render
 * `<connector>://tools-manifest`.
 *
 * Adding a tool requires adding an entry here.
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
 * Single source of truth for each tool's description + annotations.
 * `requires_approval` is derived from annotations: anything destructive OR
 * anything that isn't explicitly read-only requires approval.
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

export function annotationsForTool(toolName: string): ToolAnnotations {
  return TOOL_META[toolName]?.annotations ?? { readOnlyHint: false };
}

export function descriptionForTool(toolName: string): string {
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
