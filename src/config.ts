import { existsSync, readFileSync } from "node:fs";
import { splitCsv } from "./format.js";

export interface EmployeeApiConfig {
  baseUrl: string;
  apiKey: string;
  authDisabled: boolean;
  cacheSeconds: number;
  readPermission: string;
  writePermission: string;
  adminPermissions: string[];
}

export interface AgentPlatformClientConfig {
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  allowedTeams: string[];
}

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
  employeeApi: EmployeeApiConfig;
  agentPlatform: AgentPlatformClientConfig;
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

export function loadConfig(): ServerConfig {
  const agentPlatformUrl = env("AGENT_PLATFORM_URL").replace(/\/+$/, "");
  if (!agentPlatformUrl) {
    process.stderr.write("[workflows-mcp] warning: AGENT_PLATFORM_URL not set — workflow tools will fail.\n");
  }
  return {
    transport: parseTransport(),
    port: Number.parseInt(env("WORKFLOWS_MCP_PORT", env("PORT", "3030")), 10),
    mcpAuthToken: env("WORKFLOWS_MCP_AUTH_TOKEN") || env("MCP_AUTH_TOKEN"),
    responseMaxBytes: Number.parseInt(env("RESPONSE_MAX_BYTES", "200000"), 10),
    employeeApi: {
      baseUrl: env("EMPLOYEE_API_URL", "http://localhost:7991").replace(/\/+$/, ""),
      apiKey: env("MCP_SYNC_API_KEY") || env("EMPLOYEE_API_SERVICE_KEY") || env("EMPLOYEE_API_KEY"),
      authDisabled: ["1", "true", "yes"].includes(env("EMPLOYEE_AUTH_DISABLED", "false").toLowerCase()),
      cacheSeconds: Number.parseInt(env("EMPLOYEE_AUTH_CACHE_SECONDS", "30"), 10),
      readPermission: env("WORKFLOWS_READ_PERMISSION", "WORKFLOWS_READ"),
      writePermission: env("WORKFLOWS_WRITE_PERMISSION", "MANAGE_WORKFLOWS"),
      adminPermissions: splitCsv(env("WORKFLOWS_ADMIN_PERMISSIONS", "MANAGE_WORKFLOWS")),
    },
    agentPlatform: {
      baseUrl: agentPlatformUrl,
      apiKey: env("AGENT_PLATFORM_SYNC_KEY") || env("AGENT_PLATFORM_API_KEY") || env("MCP_SYNC_API_KEY") || env("EMPLOYEE_API_SERVICE_KEY") || env("EMPLOYEE_API_KEY"),
      enabled: Boolean(agentPlatformUrl),
      allowedTeams: splitCsv(env("MCP_ALLOWED_TEAMS")).map((t) => t.toUpperCase()),
    },
    search: {
      openaiApiKey: env("OPENAI_API_KEY"),
      embeddingsDbUrl: env("EMBEDDINGS_DB_URL", "postgres://workflows:placeholder@workflows-mcp-pgvector:5432/embeddings"),
      syncIntervalMs: Number.parseInt(env("EMBEDDINGS_SYNC_INTERVAL_MS", "300000"), 10),
      batchSize: Number.parseInt(env("EMBEDDINGS_BATCH_SIZE", "50"), 10),
      syncApiKey: env("MCP_SYNC_API_KEY") || env("AGENT_PLATFORM_SYNC_KEY") || env("AGENT_PLATFORM_API_KEY"),
    },
  };
}
