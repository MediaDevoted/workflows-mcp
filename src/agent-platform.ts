import type { AgentPlatformClientConfig } from "./config.js";
import { currentEmployeeApiKey } from "./request-context.js";

export interface WorkflowSummary {
  slug: string;
  title: string;
  description: string;
  triggers: string[];
  connectors: string[];
  assignedRoles: string[];
}

export interface WorkflowDto extends WorkflowSummary {
  bodyMarkdown: string;
}

export interface WorkflowReadResponse extends WorkflowDto {
  Includes?: WorkflowDto[];
  includes?: WorkflowDto[];
}

export interface WorkflowListFilters {
  connector?: string;
  assignedRole?: string;
  search?: string;
}

export type WorkflowReadResult =
  | { ok: true; workflow: WorkflowDto; includes: WorkflowDto[] }
  | { ok: false; status: 404; reason: "workflow_not_found" }
  | { ok: false; status: 403; reason: "workflow_not_assigned_to_your_roles" }
  | { ok: false; status: number; reason: string };

function summariesFromBody(body: unknown): WorkflowSummary[] {
  if (Array.isArray(body)) return body as WorkflowSummary[];
  if (body && typeof body === "object" && Array.isArray((body as { workflows?: unknown }).workflows)) {
    return (body as { workflows: WorkflowSummary[] }).workflows;
  }
  return [];
}

function includesFromBody(body: WorkflowReadResponse): WorkflowDto[] {
  if (Array.isArray(body.Includes)) return body.Includes;
  if (Array.isArray(body.includes)) return body.includes;
  return [];
}

export class AgentPlatformClient {
  constructor(private readonly config: AgentPlatformClientConfig) {}

  private requireBaseUrl(): string {
    if (!this.config.baseUrl) throw new Error("AGENT_PLATFORM_URL is not configured");
    return this.config.baseUrl;
  }

  private bearer(): string {
    const key = currentEmployeeApiKey();
    if (!key) throw new Error("Missing employee API key. Pass Authorization: Bearer <employee-key> or X-Employee-Api-Key.");
    return key;
  }

  async listWorkflows(filters: WorkflowListFilters = {}): Promise<WorkflowSummary[]> {
    const baseUrl = this.requireBaseUrl();
    const url = new URL(`${baseUrl}/workflows`);
    if (filters.connector) url.searchParams.set("connector", filters.connector);
    if (filters.assignedRole) url.searchParams.set("assignedRole", filters.assignedRole);
    if (filters.search) url.searchParams.set("search", filters.search);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.bearer()}`,
      },
    });
    if (!response.ok) {
      throw new Error(`agent-platform GET /workflows HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    return summariesFromBody(await response.json());
  }

  async readWorkflow(slug: string): Promise<WorkflowReadResult> {
    const baseUrl = this.requireBaseUrl();
    const response = await fetch(`${baseUrl}/workflows/${encodeURIComponent(slug)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.bearer()}`,
      },
    });

    if (response.status === 404) return { ok: false, status: 404, reason: "workflow_not_found" };
    if (response.status === 403) return { ok: false, status: 403, reason: "workflow_not_assigned_to_your_roles" };
    if (!response.ok) {
      return { ok: false, status: response.status, reason: `agent-platform GET /workflows/${slug} HTTP ${response.status}: ${(await response.text()).slice(0, 200)}` };
    }

    const body = await response.json() as WorkflowReadResponse;
    return { ok: true, workflow: body, includes: includesFromBody(body) };
  }
}
