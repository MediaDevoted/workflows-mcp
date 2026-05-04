# Workflows MCP

Hermes-optimized MCP server for governed access to **MediaDevoted workflow playbooks** — markdown documents that describe how to combine the OTHER MCPs (namecheap, cloudflare, voluum, blast, hosting, etc.) to accomplish complex operational tasks.

This is a thin wrapper over agent-platform's `/workflows` REST API. Auth is per-request: the caller's Employee API bearer key is forwarded to agent-platform, which enforces role-based visibility (intersect caller roles with each workflow's `assignedRoles`).

**Default port: `3030`** (namecheap-mcp = 3027, domain-bank-mcp = 3028).

## Architecture

```text
Hermes Agent
  -> Workflows MCP (stdio or Streamable HTTP)
    -> Employee API (/api-keys/introspect, /audit-logs)        — identity + audit
    -> Agent Platform (/workflows, /workflows/:slug)           — workflow store
```

## Tool Surface

- `workflows_list({ connector?, assignedRole?, search? })` — list workflows visible to the caller.
- `workflows_search({ query, limit? })` — search and locally re-rank by title/triggers/description matches. Default limit 5.
- `workflows_read({ slug })` — read one workflow's `bodyMarkdown` plus any prerequisite (`mustReadBefore`) workflows. Returns `{ workflow, prerequisites[], instructions }`.

All three tools are read-mode and require `WORKFLOWS_READ` (admin permissions also satisfy this) plus the per-tool key (`WORKFLOWS_TOOL_LIST`, `WORKFLOWS_TOOL_SEARCH`, `WORKFLOWS_TOOL_READ`).

## Permissions

- Connector permissions (`WORKFLOWS_READ`, `MANAGE_WORKFLOWS`) are expected to already exist in employee-api's DB.
- Per-tool permissions (`WORKFLOWS_TOOL_*`) are auto-created on boot via the catalog-sync `POST /permissions/sync`.
- Skills register with agent-platform on boot via `POST /skills/sync` with `Server: "workflows-mcp"` and empty `AllowedTeams` (open to all teams).

## Env vars

| Var | Default | Notes |
| --- | --- | --- |
| `WORKFLOWS_MCP_TRANSPORT` | `stdio` (or `http` in container) | `http` enables the Streamable HTTP server. |
| `WORKFLOWS_MCP_PORT` / `PORT` | `3030` | HTTP port. |
| `WORKFLOWS_MCP_AUTH_TOKEN` / `MCP_AUTH_TOKEN` | unset | Optional transport-level auth (`?auth=` or `X-MCP-Auth-Token`). |
| `AGENT_PLATFORM_URL` | unset (warns) | **Required** — workflow tools call this. |
| `AGENT_PLATFORM_SYNC_KEY` | falls back to `AGENT_PLATFORM_API_KEY` / `MCP_SYNC_API_KEY` | Used only by boot-time skills sync. |
| `EMPLOYEE_API_URL` | `http://localhost:7991` | RBAC + audit. |
| `MCP_SYNC_API_KEY` | unset | Service key for boot-time `permissions/sync` and audit fallback. |
| `EMPLOYEE_AUTH_DISABLED` | `false` | Bypass auth for local dev. |
| `EMPLOYEE_AUTH_CACHE_SECONDS` | `30` | introspect cache TTL. |
| `RESPONSE_MAX_BYTES` | `200000` | Truncate large responses. |
| `MCP_ALLOWED_TEAMS` | unset (open to all) | Optional CSV of team keys passed to skills sync. |

## Dev quickstart

```bash
npm install
npm run build
npm run typecheck
WORKFLOWS_MCP_TRANSPORT=http npm start
```

Hit `GET http://localhost:3030/health` to verify.

`AGENT_PLATFORM_URL` must point at a running agent-platform with the `/workflows` endpoints implemented; without it, the three tools will return errors but the server will still boot.

## Docker

```bash
cp .env.example .env
# fill values
docker compose up --build
```

Joins the external `shared-internal` network (`SHARED_NETWORK` env var, default `shared-internal-prod`) so it can reach `employee-api` and `agent-platform` by service name.
