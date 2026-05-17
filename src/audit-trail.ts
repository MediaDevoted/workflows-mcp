/**
 * Audit-trail client for workflows-mcp. Posts decision rows to the audit-trail
 * service. Failures are swallowed so a downed audit-trail never hides the
 * primary workflow result from Hermes.
 *
 * Audit-trail and employee-api are distinct services in the real topology —
 * this client only knows about audit-trail; identity lives in
 * `EmployeeIdentityClient` from `@mediadevoted/mcp-passthrough/identity`.
 */

import { currentEmployeeApiKey } from "@mediadevoted/mcp-passthrough/request-context";

const CONNECTOR = "workflows";

export interface AuditTrailConfig {
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export interface AuditInput {
  action: string;
  decision: "allow" | "deny";
  status: "success" | "error" | "skipped";
  resourceType?: string;
  resourceId?: string;
  risk?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

export class AuditTrailClient {
  constructor(private readonly config: AuditTrailConfig) {}

  private resolveKey(): string {
    const inbound = currentEmployeeApiKey();
    return inbound || this.config.apiKey || "";
  }

  async write(input: AuditInput): Promise<void> {
    if (!this.config.enabled) return;
    const apiKey = this.resolveKey();
    if (!apiKey) return;

    try {
      await fetch(`${this.config.baseUrl}/audit-logs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          connector: CONNECTOR,
          action: input.action,
          decision: input.decision,
          status: input.status,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          risk: input.risk,
          metadata: input.metadata ?? {},
          error: input.error,
        }),
      });
    } catch {
      // Audit failures must not hide the primary result.
    }
  }
}
