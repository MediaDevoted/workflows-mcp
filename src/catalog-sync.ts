export type ToolMode = "read" | "write" | "destructive";

export interface ToolManifestEntry {
  name: string;
  permission_key: string;
  mode: ToolMode;
  description: string;
  requires_approval: boolean;
}

export interface ToolManifestPayload {
  connector: string;
  connector_key: string;
  permission_keys: {
    admin: string[];
    read: string[];
    write: string[];
    tool_prefix: string;
  };
  tools: ToolManifestEntry[];
}

export interface CatalogSyncConfig {
  serverName: string;
  manifest: ToolManifestPayload;
  employeeApi: {
    baseUrl: string;
    apiKey?: string;
    adminPermissions?: string[];
  };
  agentPlatform?: {
    baseUrl: string;
    apiKey?: string;
    enabled?: boolean;
    allowedTeams?: string[];
  };
  log: (message: string) => void;
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((v) => (v ?? "").trim()).filter(Boolean))];
}

function slugFor(connector: string, toolName: string): string {
  let name = toolName.toLowerCase();
  const connectorPrefix = `${connector.toLowerCase()}_`;
  if (name.startsWith(connectorPrefix)) name = name.slice(connectorPrefix.length);
  return `${connector}.${name.replaceAll("_", "-")}`;
}

function riskClassFor(mode: ToolMode): string {
  if (mode === "destructive") return "destructive";
  if (mode === "write") return "write";
  return "safe";
}

function modePermissions(manifest: ToolManifestPayload, mode: ToolMode): string[] {
  if (mode === "read") return manifest.permission_keys.read;
  return manifest.permission_keys.write;
}

async function postJson(
  url: string,
  apiKey: string | undefined,
  body: unknown,
  timeoutMs = 5000,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

function parseCounts(text: string, keys: string[]): string {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    return keys
      .map((key) => `${key}=${Array.isArray(body[key]) ? body[key].length : 0}`)
      .join(" ");
  } catch {
    return text.slice(0, 160);
  }
}

async function syncPermissions(config: CatalogSyncConfig): Promise<void> {
  const baseUrl = config.employeeApi.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) return;

  const keys = unique([
    ...config.manifest.permission_keys.admin,
    ...config.manifest.permission_keys.read,
    ...config.manifest.permission_keys.write,
    ...(config.employeeApi.adminPermissions ?? []),
    ...config.manifest.tools.map((tool) => tool.permission_key),
  ]);

  const response = await postJson(
    `${baseUrl}/permissions/sync`,
    config.employeeApi.apiKey,
    { keys },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`permissions/sync HTTP ${response.status}: ${response.text.slice(0, 160)}`);
  }
  config.log(`permission catalog sync ok (${parseCounts(response.text, ["created", "existing", "skipped"])})`);
}

async function syncSkills(config: CatalogSyncConfig): Promise<void> {
  const agentPlatform = config.agentPlatform;
  const baseUrl = agentPlatform?.baseUrl.replace(/\/+$/, "");
  if (!agentPlatform?.enabled || !baseUrl) return;

  const adminPermissions = unique([
    ...config.manifest.permission_keys.admin,
    ...(config.employeeApi.adminPermissions ?? []),
  ]);

  const allowedTeams = unique((agentPlatform.allowedTeams ?? []).map((t) => t.toUpperCase()));

  const skills = config.manifest.tools.map((tool) => ({
    slug: slugFor(config.manifest.connector, tool.name),
    server: config.serverName,
    description: tool.description,
    riskClass: riskClassFor(tool.mode),
    requiresConfirmation: tool.requires_approval,
    tags: unique([config.manifest.connector, config.manifest.connector_key.toLowerCase(), tool.mode, "mcp-tool"]),
    requiredPermissions: unique([
      tool.permission_key,
      ...modePermissions(config.manifest, tool.mode),
      ...adminPermissions,
    ]),
    allowedTeams,
  }));

  const response = await postJson(
    `${baseUrl}/skills/sync`,
    agentPlatform.apiKey,
    { skills },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`skills/sync HTTP ${response.status}: ${response.text.slice(0, 160)}`);
  }
  config.log(`skill catalog sync ok (${parseCounts(response.text, ["created", "updated", "skipped"])})`);
}

export async function syncCatalogOnBoot(config: CatalogSyncConfig): Promise<void> {
  if (["1", "true", "yes"].includes((process.env.MCP_CATALOG_SYNC_DISABLED ?? "").toLowerCase())) {
    config.log("catalog sync disabled by MCP_CATALOG_SYNC_DISABLED");
    return;
  }

  try {
    await syncPermissions(config);
  } catch (error) {
    config.log(`permission catalog sync skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await syncSkills(config);
  } catch (error) {
    config.log(`skill catalog sync skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
