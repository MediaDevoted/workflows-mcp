import type { EmployeeApiConfig } from "./config.js";
import { currentEmployeeApiKey } from "./request-context.js";

export interface EmployeePrincipal {
  active: boolean;
  allowed: boolean;
  reason?: string | null;
  apiKeyId?: string | null;
  apiKeyPrefix?: string | null;
  user?: {
    id: string;
    slackUserId: string;
    name: string;
    email: string;
    imageUrl: string;
  } | null;
  teams: string[];
  roles: string[];
  rolePermissions: string[];
  effectivePermissions: string[];
  permissionScopes: string[];
}

export type ActionDecision =
  | { ok: true; principal: EmployeePrincipal; apiKey: string }
  | { ok: false; reason: string; principal?: EmployeePrincipal; apiKey?: string };

export interface AuditInput {
  action: string;
  resourceType?: string;
  resourceId?: string;
  risk?: string;
  decision: "allow" | "deny";
  status: "success" | "error" | "skipped";
  metadata?: Record<string, unknown>;
  error?: string;
}

interface CacheEntry {
  expiresAt: number;
  principal: EmployeePrincipal;
}

function inactivePrincipal(reason: string): EmployeePrincipal {
  return {
    active: false,
    allowed: false,
    reason,
    apiKeyId: null,
    apiKeyPrefix: null,
    user: null,
    teams: [],
    roles: [],
    rolePermissions: [],
    effectivePermissions: [],
    permissionScopes: [],
  };
}

export class EmployeeApiClient {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly config: EmployeeApiConfig) {}

  private resolveKey(): string {
    return currentEmployeeApiKey();
  }

  hasPermission(principal: EmployeePrincipal, requiredPermission: string): boolean {
    if (!requiredPermission) return true;
    const effective = new Set(principal.effectivePermissions.map((p) => p.toUpperCase()));
    if (effective.has(requiredPermission.toUpperCase())) return true;
    return this.config.adminPermissions.some((p) => effective.has(p.toUpperCase()));
  }

  async introspect(): Promise<{ apiKey: string; principal: EmployeePrincipal }> {
    if (this.config.authDisabled) {
      return {
        apiKey: "auth-disabled",
        principal: {
          active: true,
          allowed: true,
          reason: null,
          apiKeyId: "auth-disabled",
          apiKeyPrefix: "auth-disabled",
          user: {
            id: "auth-disabled",
            slackUserId: "auth-disabled",
            name: "Auth Disabled",
            email: "",
            imageUrl: "",
          },
          teams: ["AUTH_DISABLED"],
          roles: ["AUTH_DISABLED"],
          rolePermissions: this.config.adminPermissions,
          effectivePermissions: this.config.adminPermissions,
          permissionScopes: [],
        },
      };
    }

    const apiKey = this.resolveKey();
    if (!apiKey) throw new Error("Missing employee API key. Pass Authorization: Bearer <employee-key> or X-Employee-Api-Key.");

    const cached = this.cache.get(apiKey);
    if (cached && cached.expiresAt > Date.now()) return { apiKey, principal: cached.principal };

    const response = await fetch(`${this.config.baseUrl}/api-keys/introspect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({}),
    });

    if (response.status === 401) {
      const principal = inactivePrincipal("invalid_or_inactive_api_key");
      this.cache.set(apiKey, {
        principal,
        expiresAt: Date.now() + Math.max(1, this.config.cacheSeconds) * 1000,
      });
      return { apiKey, principal };
    }
    if (!response.ok) throw new Error(`Employee API introspection failed: HTTP ${response.status} ${await response.text()}`);

    const body = await response.json() as Partial<EmployeePrincipal>;
    const principal: EmployeePrincipal = {
      active: body.active ?? true,
      allowed: body.allowed ?? true,
      reason: body.reason ?? null,
      apiKeyId: body.apiKeyId ?? null,
      apiKeyPrefix: body.apiKeyPrefix ?? null,
      user: body.user ?? null,
      teams: body.teams ?? [],
      roles: body.roles ?? [],
      rolePermissions: body.rolePermissions ?? [],
      effectivePermissions: body.effectivePermissions ?? [],
      permissionScopes: body.permissionScopes ?? [],
    };
    this.cache.set(apiKey, {
      principal,
      expiresAt: Date.now() + Math.max(1, this.config.cacheSeconds) * 1000,
    });
    return { apiKey, principal };
  }

  async authorize(requiredPermission: string | string[]): Promise<ActionDecision> {
    try {
      const required = Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission];
      const filtered = required.filter((p) => Boolean(p));
      const { apiKey, principal } = await this.introspect();
      if (!principal.active) return { ok: false, apiKey, principal, reason: principal.reason || "inactive_employee_api_key" };
      if (filtered.length > 0 && !filtered.every((p) => this.hasPermission(principal, p))) {
        return { ok: false, apiKey, principal, reason: `missing_permission:${filtered.join("|")}` };
      }
      return { ok: true, apiKey, principal };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async audit(input: AuditInput): Promise<void> {
    if (this.config.authDisabled) return;
    const auditTrailUrl = (process.env.AUDIT_TRAIL_URL ?? "").replace(/\r/g, "").trim().replace(/\/+$/, "");
    const apiKey = currentEmployeeApiKey();
    if (!apiKey) return;

    try {
      await fetch(`${auditTrailUrl || this.config.baseUrl}/audit-logs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          connector: "workflows",
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          risk: input.risk,
          decision: input.decision,
          status: input.status,
          metadata: input.metadata ?? {},
          error: input.error,
        }),
      });
    } catch {
      // Audit failures should not hide the primary result from Hermes.
    }
  }
}
