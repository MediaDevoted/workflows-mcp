import type { WorkflowDto, WorkflowSummary } from "../agent-platform.js";
import { EmbeddingsClient, EmbeddingsUnavailableError } from "./embeddings.js";
import { EmbeddingsStore, StoreUnavailableError, type UpsertRow } from "./store.js";

const BODY_CHAR_LIMIT = 32_000;

export interface SyncOptions {
  agentPlatformBaseUrl: string;
  syncApiKey: string;
  store: EmbeddingsStore;
  embeddings: EmbeddingsClient;
  batchSize: number;
  intervalMs: number;
  log: (message: string) => void;
}

interface PendingChange {
  summary: WorkflowSummary;
  body: string;
}

function summariesFromBody(body: unknown): WorkflowSummary[] {
  if (Array.isArray(body)) return body as WorkflowSummary[];
  if (body && typeof body === "object" && Array.isArray((body as { workflows?: unknown }).workflows)) {
    return (body as { workflows: WorkflowSummary[] }).workflows;
  }
  return [];
}

function summaryUpdatedAt(workflow: WorkflowSummary): string {
  const candidate = (workflow as unknown as { updatedAt?: string; updated_at?: string }).updatedAt
    ?? (workflow as unknown as { updatedAt?: string; updated_at?: string }).updated_at;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  return new Date(0).toISOString();
}

function discoveryText(summary: WorkflowSummary): string {
  const triggers = (summary.triggers ?? []).join(", ");
  return `${summary.title ?? ""}\n${summary.description ?? ""}\nTRIGGERS: ${triggers}`;
}

function bodyText(workflow: WorkflowDto): string {
  return (workflow.bodyMarkdown ?? "").slice(0, BODY_CHAR_LIMIT);
}

async function fetchAllWorkflows(baseUrl: string, syncKey: string): Promise<WorkflowSummary[]> {
  const response = await fetch(`${baseUrl}/workflows?search=`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${syncKey}` },
  });
  if (!response.ok) {
    throw new Error(`agent-platform GET /workflows HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return summariesFromBody(await response.json());
}

async function fetchWorkflowBody(baseUrl: string, syncKey: string, slug: string): Promise<WorkflowDto> {
  const response = await fetch(`${baseUrl}/workflows/${encodeURIComponent(slug)}`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${syncKey}` },
  });
  if (!response.ok) {
    throw new Error(`agent-platform GET /workflows/${slug} HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()) as WorkflowDto;
}

export class SyncRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: SyncOptions) {}

  start(): void {
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, Math.max(10_000, this.opts.intervalMs));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const started = Date.now();
    let fetched = 0;
    let changed = 0;
    let deleted = 0;
    try {
      const summaries = await fetchAllWorkflows(this.opts.agentPlatformBaseUrl, this.opts.syncApiKey);
      fetched = summaries.length;

      const existing = await this.opts.store.listExisting();
      const existingMap = new Map(existing.map((r) => [r.slug, r.updatedAt]));

      const seenSlugs = new Set(summaries.map((s) => s.slug));
      const stale = existing.filter((r) => !seenSlugs.has(r.slug)).map((r) => r.slug);

      const pending: PendingChange[] = [];
      for (const summary of summaries) {
        const newUpdatedAt = summaryUpdatedAt(summary);
        const existingUpdatedAt = existingMap.get(summary.slug);
        if (existingUpdatedAt && Date.parse(existingUpdatedAt) >= Date.parse(newUpdatedAt)) continue;
        const workflow = await fetchWorkflowBody(this.opts.agentPlatformBaseUrl, this.opts.syncApiKey, summary.slug);
        pending.push({ summary, body: bodyText(workflow) });
      }

      for (let i = 0; i < pending.length; i += this.opts.batchSize) {
        const chunk = pending.slice(i, i + this.opts.batchSize);
        const inputs: string[] = [];
        for (const entry of chunk) {
          inputs.push(discoveryText(entry.summary));
          inputs.push(entry.body || entry.summary.title || entry.summary.slug);
        }
        const vectors = await this.opts.embeddings.embedBatch(inputs);
        const rows: UpsertRow[] = chunk.map((entry, idx) => ({
          slug: entry.summary.slug,
          title: entry.summary.title,
          description: entry.summary.description ?? "",
          triggers: entry.summary.triggers ?? [],
          connectors: entry.summary.connectors ?? [],
          assignedRoles: entry.summary.assignedRoles ?? [],
          updatedAt: summaryUpdatedAt(entry.summary),
          discoveryEmbedding: vectors[idx * 2]!,
          bodyEmbedding: vectors[idx * 2 + 1]!,
        }));
        await this.opts.store.upsert(rows);
        changed += rows.length;
      }

      if (stale.length > 0) {
        deleted = await this.opts.store.deleteSlugs(stale);
      }

      this.opts.log(`[sync] fetched=${fetched} changed=${changed} deleted=${deleted} elapsed=${Date.now() - started}ms`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const tag = error instanceof EmbeddingsUnavailableError
        ? "embeddings-unavailable"
        : error instanceof StoreUnavailableError
          ? "store-unavailable"
          : "error";
      this.opts.log(`[sync] skipped (${tag}): ${msg}`);
    } finally {
      this.running = false;
    }
  }
}
