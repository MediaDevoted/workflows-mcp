/**
 * Tool-visibility filter — hides specific tools from the LLM.
 *
 * Fetches `{ tools: ["voluum.x.y", ...] }` from agent-platform's
 * `/v1/tool-visibility/hidden-public?connector=<connector>` endpoint and keeps
 * a local Set in memory. The MCP filters those tool names out of `tools/list`
 * responses so the LLM never sees them, and rejects `tools/call` for them so a
 * hallucinated name fails cleanly.
 *
 * Default state: empty set (behavior unchanged). Failure mode: fail-open — if
 * agent-platform is down or the endpoint is missing, we keep the existing set
 * (or empty if never fetched) and log a warning, rather than breaking the MCP.
 */

export interface ToolVisibilityConfig {
  /** Agent-platform base URL. Empty string disables the client. */
  baseUrl: string;
  /** Service token sent as `Authorization: Bearer <token>`. */
  apiKey: string;
  /** Connector key (matches the dashboard's connector key). */
  connector: string;
  /** Background refresh interval in ms. Default 60_000. */
  refreshIntervalMs?: number;
  /** Per-fetch timeout in ms. Default 5_000. */
  fetchTimeoutMs?: number;
  /** Logger. Defaults to a no-op. */
  log?: (message: string) => void;
}

type Listener = (hidden: ReadonlySet<string>) => void;

export class ToolVisibilityClient {
  private hidden = new Set<string>();
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFetchedAt = 0;

  constructor(private readonly config: ToolVisibilityConfig) {}

  /** Returns true when the tool should be hidden from `tools/list` and `tools/call`. */
  isHidden(toolName: string): boolean {
    return this.hidden.has(toolName);
  }

  /** Number of hidden tools currently in the set. */
  getHiddenCount(): number {
    return this.hidden.size;
  }

  /** Snapshot of the current hidden set. */
  getHiddenSet(): ReadonlySet<string> {
    return new Set(this.hidden);
  }

  /** Subscribe to set changes. Returns an unsubscribe function. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Fetch the hidden list from agent-platform. On failure, the existing set is
   * preserved (fail-open) and a warning is logged. Resolves to true when the
   * set actually changed.
   */
  async refresh(): Promise<boolean> {
    const log = this.config.log ?? (() => {});
    const baseUrl = this.config.baseUrl.replace(/\/+$/, "");
    if (!baseUrl) {
      // No agent-platform configured — keep empty set, behavior unchanged.
      return false;
    }
    const url = `${baseUrl}/v1/tool-visibility/hidden-public?connector=${encodeURIComponent(this.config.connector)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.fetchTimeoutMs ?? 5_000);
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: this.config.apiKey ? `Bearer ${this.config.apiKey}` : "",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        log(`tool-visibility refresh skipped: HTTP ${response.status}`);
        return false;
      }
      const body = await response.json() as { tools?: unknown };
      const next = parseHiddenList(body);
      this.lastFetchedAt = Date.now();
      const changed = !setsEqual(this.hidden, next);
      if (changed) {
        this.hidden = next;
        const snapshot = this.getHiddenSet();
        for (const listener of this.listeners) {
          try {
            listener(snapshot);
          } catch (error) {
            log(`tool-visibility listener error: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        log(`tool-visibility set updated: ${next.size} tool(s) hidden`);
      }
      return changed;
    } catch (error) {
      // Network error, timeout, parse error — fail open, keep the existing set.
      log(`tool-visibility refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Start the periodic background refresh. Safe to call multiple times. */
  startBackgroundRefresh(): void {
    if (this.timer) return;
    const intervalMs = Math.max(1_000, this.config.refreshIntervalMs ?? 60_000);
    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    // Don't keep the event loop alive just for this.
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Stop the periodic background refresh. */
  stopBackgroundRefresh(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Replace the hidden set directly. Intended for tests. */
  setHiddenForTest(names: Iterable<string>): void {
    this.hidden = new Set(names);
    const snapshot = this.getHiddenSet();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function parseHiddenList(body: { tools?: unknown }): Set<string> {
  const raw = body.tools;
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) out.add(item.trim());
  }
  return out;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Apply the current hidden set to an McpServer's registered tools by toggling
 * each tool's `enabled` flag. The SDK already filters `tools/list` by the flag
 * and rejects `tools/call` for disabled tools, so this is the smallest surgical
 * change that makes hidden tools invisible to the LLM.
 *
 * The McpServer instance is typed `any` because we touch the SDK's internal
 * `_registeredTools` map — there is no public accessor as of @modelcontextprotocol/sdk@1.x.
 */
export function applyHiddenFilter(server: unknown, client: ToolVisibilityClient): void {
  if (!server || typeof server !== "object") return;
  const registered = (server as { _registeredTools?: Record<string, RegisteredToolLike> })._registeredTools;
  if (!registered || typeof registered !== "object") return;
  for (const [name, tool] of Object.entries(registered)) {
    if (!tool || typeof tool !== "object") continue;
    const shouldBeEnabled = !client.isHidden(name);
    if (tool.enabled === shouldBeEnabled) continue;
    if (shouldBeEnabled) tool.enable?.();
    else tool.disable?.();
  }
}

interface RegisteredToolLike {
  enabled?: boolean;
  enable?: () => void;
  disable?: () => void;
}
