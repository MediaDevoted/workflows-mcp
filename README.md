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

### Read tools (require `WORKFLOWS_READ`)

| Tool | Args | Notes |
|---|---|---|
| `workflows_status` | — | Connector health: version, agent-platform status, embeddings state. |
| `workflows_list` | `connector?`, `assignedRole?`, `search?` | List workflows visible to the caller. |
| `workflows_search` | `query`, `limit?` (1-20), `mode?` (`fast`\|`deep`) | Semantic search via OpenAI embeddings + pgvector cosine similarity. `mode='fast'` (default) ranks on title/description/triggers; `mode='deep'` blends in the full body. Falls back to literal trigger ranking (`degraded: true`) when embeddings are unavailable. |
| `workflows_read` | `slug` | Read one workflow's `bodyMarkdown` plus any prerequisite (`mustReadBefore`) workflows. Returns `{ workflow, prerequisites[], instructions }`. |

### Write tools (require `MANAGE_WORKFLOWS`)

| Tool | Args | Notes |
|---|---|---|
| `workflows_create` | `slug`, `title`, `bodyMarkdown`, `description?`, `triggers?`, `connectors?`, `mustReadBefore?`, `assignedRoles?`, `dry_run?`, `confirm?`, `approval_note?` | Create a new workflow playbook. |
| `workflows_update` | `slug`, `title`, `bodyMarkdown`, … (same optional fields) | Update an existing workflow. Slug is immutable. |
| `workflows_delete` | `slug`, `confirm`, `approval_note?`, `dry_run?` | Destructive. Requires `confirm=true`. |

All tools also require a per-tool permission key auto-created on boot: `WORKFLOWS_TOOL_<TOOLNAME>` (e.g. `WORKFLOWS_TOOL_LIST`, `WORKFLOWS_TOOL_SEARCH`, `WORKFLOWS_TOOL_READ`, `WORKFLOWS_TOOL_CREATE`, `WORKFLOWS_TOOL_UPDATE`, `WORKFLOWS_TOOL_DELETE`, `WORKFLOWS_TOOL_STATUS`).

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
| `EMPLOYEE_API_SERVICE_KEY` / `EMPLOYEE_API_KEY` | unset | Alternative service key names (resolved in order after `MCP_SYNC_API_KEY`). |
| `WORKFLOWS_READ_PERMISSION` | `WORKFLOWS_READ` | Coarse read permission key. |
| `WORKFLOWS_WRITE_PERMISSION` | `MANAGE_WORKFLOWS` | Coarse write permission key. |
| `WORKFLOWS_ADMIN_PERMISSIONS` | `MANAGE_WORKFLOWS,MANAGE_ACCESS,MANAGE_SETTINGS` | CSV of permissions that count as admin. |
| `WORKFLOWS_CROSS_TEAM_READ_PERMISSIONS` | unset | CSV of permissions that grant cross-team read access. |
| `AUDIT_TRAIL_URL` | unset | When set, every tool call writes an audit row to this service. |
| `AUDIT_TRAIL_API_KEY` | falls back to `MCP_SYNC_API_KEY` | Auth for the audit-trail service. |
| `WORKFLOWS_APPROVAL_TOKEN_SECRET` | falls back to `MCP_SYNC_API_KEY` | Signs approval tokens for write tools. |
| `RESPONSE_MAX_BYTES` | `200000` | Truncate large responses. |
| `MCP_ALLOWED_TEAMS` | unset (open to all) | Optional CSV of uppercase team keys passed to skills sync. |
| `MCP_DYNAMIC_TOOLSETS` | unset | Override dynamic-toolset visibility. |
| `OPENAI_API_KEY` | unset | Required to enable semantic search. When unset, `workflows_search` degrades to literal trigger ranking. |
| `EMBEDDINGS_DB_PASSWORD` | unset | Password used by the bundled `workflows-mcp-pgvector` sidecar (compose interpolation). |
| `EMBEDDINGS_DB_URL` | `postgres://workflows:placeholder@workflows-mcp-pgvector:5432/embeddings` | Postgres+pgvector connection string. |
| `EMBEDDINGS_SYNC_INTERVAL_MS` | `300000` | How often the embeddings sync loop runs. |
| `EMBEDDINGS_BATCH_SIZE` | `50` | How many workflows to embed per OpenAI batch request. |

## Dev quickstart

Requires a GitHub Packages token to install `@mediadevoted/mcp-passthrough`:

```bash
export NPM_TOKEN=<your-github-packages-token>
npm install
npm run typecheck   # tsc --noEmit
npm test            # contract suite + search-trim tests
npm run build       # tsc → dist/
```

Run in HTTP mode:

```bash
cp .env.template .env   # fill in AGENT_PLATFORM_URL at minimum
EMPLOYEE_AUTH_DISABLED=true WORKFLOWS_MCP_TRANSPORT=http npm start
```

Hit `GET http://localhost:3030/health` to verify.

For stdio mode (e.g. Hermes local config), use `npm run dev` (tsx, no build step) or `node dist/index.js` after building.

`AGENT_PLATFORM_URL` must point at a running agent-platform with the `/workflows` endpoints; without it the tools return errors but the server still boots and `/health` returns `200`.

## Docker

The compose stack runs two containers: `workflows-mcp` (the MCP server) and `workflows-mcp-pgvector` (a pgvector sidecar for embeddings).

```bash
cp .env.template .env   # or copy .env.example — same variables, template has fuller comments
# fill in AGENT_PLATFORM_URL, MCP_SYNC_API_KEY, EMBEDDINGS_DB_PASSWORD at minimum
NPM_TOKEN=<github-packages-token> docker compose up --build
```

`EMBEDDINGS_DB_PASSWORD` is required by the pgvector sidecar at startup (compose enforces this). `OPENAI_API_KEY` is optional; without it, semantic search degrades to trigger ranking.

The `workflows-mcp` container joins the external `shared-internal` network (name controlled by `SHARED_NETWORK`, default `shared-internal-prod`) so it can reach `employee-api` and `agent-platform` by service name.

## Client registration (Hermes)

To register this server with Hermes as a connector MCP:

1. Add `workflows-mcp` to the agent-platform connector registry pointing at `http://<host>:3030`.
2. Grant the calling employee-api key the `WORKFLOWS_READ` permission (and `MANAGE_WORKFLOWS` for write access).
3. The server auto-creates `WORKFLOWS_TOOL_*` per-tool permission keys on boot via `POST /permissions/sync`.
4. Skills are registered automatically on boot via `POST /skills/sync` with `Server: "workflows-mcp"` and empty `AllowedTeams` (open to all teams, unless `MCP_ALLOWED_TEAMS` is set).

In stdio mode (local Hermes config):

```json
{
  "mcpServers": {
    "workflows-mcp": {
      "command": "node",
      "args": ["/path/to/workflows-mcp/dist/index.js"],
      "env": {
        "AGENT_PLATFORM_URL": "http://localhost:7992",
        "EMPLOYEE_API_URL": "http://localhost:7991",
        "MCP_SYNC_API_KEY": "<service-key>"
      }
    }
  }
}
```
