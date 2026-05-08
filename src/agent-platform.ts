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

export interface WorkflowCreateInput {
  slug: string;
  title: string;
  bodyMarkdown: string;
  description?: string | null;
  triggers?: string[] | null;
  connectors?: string[] | null;
  mustReadBefore?: string[] | null;
  assignedRoles?: string[] | null;
  source?: string | null;
}

export interface WorkflowUpdateInput {
  title: string;
  bodyMarkdown: string;
  description?: string | null;
  triggers?: string[] | null;
  connectors?: string[] | null;
  mustReadBefore?: string[] | null;
  assignedRoles?: string[] | null;
  source?: string | null;
}

export type WorkflowMutationResult<T> =
  | { ok: true; result: T }
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

  async createWorkflow(input: WorkflowCreateInput): Promise<WorkflowMutationResult<{ slug: string }>> {
    const baseUrl = this.requireBaseUrl();
    const payload = {
      slug: input.slug,
      title: input.title,
      bodyMarkdown: input.bodyMarkdown,
      description: input.description ?? undefined,
      triggers: input.triggers ?? undefined,
      connectors: input.connectors ?? undefined,
      mustReadBefore: input.mustReadBefore ?? undefined,
      assignedRoles: input.assignedRoles ?? undefined,
      source: input.source ?? "hermes",
    };
    const response = await fetch(`${baseUrl}/workflows`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.bearer()}`,
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 201) return { ok: true, result: { slug: input.slug.trim().toLowerCase() } };
    const text = (await response.text()).slice(0, 400);
    if (response.status === 400) return { ok: false, status: 400, reason: text || "bad_request" };
    if (response.status === 403) return { ok: false, status: 403, reason: "missing_manage_workflows_permission" };
    return { ok: false, status: response.status, reason: text || `agent-platform POST /workflows HTTP ${response.status}` };
  }

  async updateWorkflow(slug: string, input: WorkflowUpdateInput): Promise<WorkflowMutationResult<true>> {
    const baseUrl = this.requireBaseUrl();
    const payload = {
      title: input.title,
      bodyMarkdown: input.bodyMarkdown,
      description: input.description ?? undefined,
      triggers: input.triggers ?? undefined,
      connectors: input.connectors ?? undefined,
      mustReadBefore: input.mustReadBefore ?? undefined,
      assignedRoles: input.assignedRoles ?? undefined,
      source: input.source ?? undefined,
    };
    const response = await fetch(`${baseUrl}/workflows/${encodeURIComponent(slug)}`, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.bearer()}`,
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 204) return { ok: true, result: true };
    const text = (await response.text()).slice(0, 400);
    if (response.status === 400) return { ok: false, status: 400, reason: text || "bad_request" };
    if (response.status === 404) return { ok: false, status: 404, reason: "workflow_not_found" };
    if (response.status === 403) return { ok: false, status: 403, reason: "missing_manage_workflows_permission" };
    return { ok: false, status: response.status, reason: text || `agent-platform PUT /workflows/${slug} HTTP ${response.status}` };
  }

  async deleteWorkflow(slug: string): Promise<WorkflowMutationResult<true>> {
    const baseUrl = this.requireBaseUrl();
    const response = await fetch(`${baseUrl}/workflows/${encodeURIComponent(slug)}`, {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.bearer()}`,
      },
    });

    if (response.status === 204) return { ok: true, result: true };
    const text = (await response.text()).slice(0, 400);
    if (response.status === 404) return { ok: false, status: 404, reason: "workflow_not_found" };
    if (response.status === 403) return { ok: false, status: 403, reason: "missing_manage_workflows_permission" };
    return { ok: false, status: response.status, reason: text || `agent-platform DELETE /workflows/${slug} HTTP ${response.status}` };
  }
}
