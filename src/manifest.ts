export type ToolMode = "read" | "write" | "destructive";

export interface ToolManifestEntry {
  name: string;
  permission_key: string;
  mode: ToolMode;
  description: string;
  requires_approval: boolean;
}

export const CONNECTOR = "workflows";
export const CONNECTOR_KEY = "WORKFLOWS";

export function toolPermissionKey(toolName: string): string {
  const upper = toolName.toUpperCase();
  if (upper.startsWith(`${CONNECTOR_KEY}_`)) {
    return `${CONNECTOR_KEY}_TOOL_${upper.slice(CONNECTOR_KEY.length + 1)}`;
  }
  return `${CONNECTOR_KEY}_TOOL_${upper}`;
}

const TOOL_SOURCE: Array<Omit<ToolManifestEntry, "permission_key">> = [
  { name: "workflows_list", mode: "read", requires_approval: false, description: "List workflow playbooks visible to the caller. Optional filters: connector, assignedRole, search." },
  { name: "workflows_search", mode: "read", requires_approval: false, description: "Semantic search over workflow playbooks via OpenAI embeddings + pgvector. Accepts mode='fast'|'deep'." },
  { name: "workflows_read", mode: "read", requires_approval: false, description: "Read a single workflow's bodyMarkdown plus any prerequisite workflows (mustReadBefore)." },
  { name: "workflows_create", mode: "write", requires_approval: false, description: "Create a new workflow playbook. Requires MANAGE_WORKFLOWS." },
  { name: "workflows_update", mode: "write", requires_approval: false, description: "Update an existing workflow playbook (slug is immutable). Requires MANAGE_WORKFLOWS." },
  { name: "workflows_delete", mode: "destructive", requires_approval: true, description: "Delete a workflow playbook. Requires MANAGE_WORKFLOWS and explicit confirm=true." },
];

export const TOOLS_MANIFEST: ToolManifestEntry[] = TOOL_SOURCE.map((entry) => ({
  ...entry,
  permission_key: toolPermissionKey(entry.name),
}));

export function lookupTool(name: string): ToolManifestEntry | undefined {
  return TOOLS_MANIFEST.find((entry) => entry.name === name);
}

export function manifestPayload(meta?: Record<string, unknown>) {
  return {
    connector: CONNECTOR,
    connector_key: CONNECTOR_KEY,
    permission_keys: {
      admin: ["MANAGE_WORKFLOWS"],
      read: ["WORKFLOWS_READ"],
      write: ["MANAGE_WORKFLOWS"],
      tool_prefix: `${CONNECTOR_KEY}_TOOL_`,
    },
    generated_at: new Date().toISOString(),
    tools: TOOLS_MANIFEST,
    ...(meta ?? {}),
  };
}
