/**
 * Workflows-mcp configuration loader. Only connector-specific knobs live
 * here; everything else (transport, identity, dynamic toolsets) is wired
 * through `@mediadevoted/mcp-passthrough` from `index.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { splitCsv } from "./format.js";

export interface SearchConfig {
  openaiApiKey: string;
  embeddingsDbUrl: string;
  syncIntervalMs: number;
  batchSize: number;
  syncApiKey: string;
}

export interface ServerConfig {
  transport: "stdio" | "http";
  port: number;
  mcpAuthToken: string;
  responseMaxBytes: number;
  approvalTokenSecret: string;

  // Identity (employee-api).
  employeeApiUrl: string;
  employeeApiServiceKey: string;
  employeeAuthDisabled: boolean;
  employeeAuthCacheSeconds: number;

  // RBAC.
  readPermission: string;
  writePermission: string;
  adminPermissions: string[];
  crossTeamReadPermissions: string[];

  // Agent platform (workflow store + skills sync).
  agentPlatformUrl: string;
  agentPlatformApiKey: string;
  agentPlatformEnabled: boolean;
  allowedTeams: string[];

  // Audit-trail (separate service).
  auditTrailUrl: string;
  auditTrailApiKey: string;
  auditTrailEnabled: boolean;

  // Semantic search (pgvector sidecar).
  search: SearchConfig;
}

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).replace(/\r/g, "").trim();
}

function runningInContainer(): boolean {
  if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) return true;
  try {
    return /(docker|containerd|kubepods|podman|lxc|crio)/i.test(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return false;
  }
}

function parseTransport(): "stdio" | "http" {
  const raw = env("WORKFLOWS_MCP_TRANSPORT").toLowerCase();
  if (runningInContainer()) return "http";
  if (raw === "http") return "http";
  return "stdio";
}

function parseBool(name: string, fallback: boolean): boolean {
  const raw = env(name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

export function loadConfig(): ServerConfig {
  const agentPlatformUrl = env("AGENT_PLATFORM_URL").replace(/\/+$/, "");
  if (!agentPlatformUrl) {
    process.stderr.write("[workflows-mcp] warning: AGENT_PLATFORM_URL not set — workflow tools will fail.\n");
  }
  const auditTrailUrl = env("AUDIT_TRAIL_URL").replace(/\/+$/, "");
  const serviceKey =
    env("MCP_SYNC_API_KEY") ||
    env("EMPLOYEE_API_SERVICE_KEY") ||
    env("EMPLOYEE_API_KEY");

  return {
    transport: parseTransport(),
    port: Number.parseInt(env("WORKFLOWS_MCP_PORT", env("PORT", "3030")), 10),
    mcpAuthToken: env("WORKFLOWS_MCP_AUTH_TOKEN") || env("MCP_AUTH_TOKEN"),
    responseMaxBytes: Number.parseInt(env("RESPONSE_MAX_BYTES", "200000"), 10),
    approvalTokenSecret: env("WORKFLOWS_APPROVAL_TOKEN_SECRET") || serviceKey || "workflows-mcp-dev-secret",

    employeeApiUrl: env("EMPLOYEE_API_URL", "http://localhost:7991").replace(/\/+$/, ""),
    employeeApiServiceKey: serviceKey,
    employeeAuthDisabled: parseBool("EMPLOYEE_AUTH_DISABLED", false),
    employeeAuthCacheSeconds: Number.parseInt(env("EMPLOYEE_AUTH_CACHE_SECONDS", "30"), 10),

    readPermission: env("WORKFLOWS_READ_PERMISSION", "WORKFLOWS_READ"),
    writePermission: env("WORKFLOWS_WRITE_PERMISSION", "MANAGE_WORKFLOWS"),
    adminPermissions: splitCsv(env("WORKFLOWS_ADMIN_PERMISSIONS", "MANAGE_WORKFLOWS")),
    crossTeamReadPermissions: splitCsv(env("WORKFLOWS_CROSS_TEAM_READ_PERMISSIONS")),

    agentPlatformUrl,
    agentPlatformApiKey:
      env("AGENT_PLATFORM_SYNC_KEY") || env("AGENT_PLATFORM_API_KEY") || serviceKey,
    agentPlatformEnabled: Boolean(agentPlatformUrl),
    allowedTeams: splitCsv(env("MCP_ALLOWED_TEAMS")).map((t) => t.toUpperCase()),

    auditTrailUrl,
    auditTrailApiKey: env("AUDIT_TRAIL_API_KEY") || serviceKey,
    auditTrailEnabled: Boolean(auditTrailUrl),

    search: {
      openaiApiKey: env("OPENAI_API_KEY"),
      embeddingsDbUrl: env(
        "EMBEDDINGS_DB_URL",
        "postgres://workflows:placeholder@workflows-mcp-pgvector:5432/embeddings",
      ),
      syncIntervalMs: Number.parseInt(env("EMBEDDINGS_SYNC_INTERVAL_MS", "300000"), 10),
      batchSize: Number.parseInt(env("EMBEDDINGS_BATCH_SIZE", "50"), 10),
      syncApiKey:
        env("MCP_SYNC_API_KEY") || env("AGENT_PLATFORM_SYNC_KEY") || env("AGENT_PLATFORM_API_KEY"),
    },
  };
}
