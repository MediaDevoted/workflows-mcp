# Contributing to workflows-mcp

Internal MediaDevoted repo. External contributions are not accepted.

## Branch workflow

```
feature/your-branch  →  dev  →  main
```

- All changes land on `dev` first; `main` is protected and requires a passing PR.
- Branch naming: `<yourname>/feat/<slug>`, `<yourname>/fix/<slug>`, or `<yourname>/misc/<slug>`.
- Squash is **not** allowed on `main` — use merge commits only (org ruleset).

## Local development

```bash
npm install            # pulls @mediadevoted/mcp-passthrough from GitHub Packages
                       # (requires NPM_TOKEN env var — see .env.template)
npm run typecheck      # tsc --noEmit
npm test               # node:test contract suite + search-trim tests
npm run dev            # tsx src/index.ts  (stdio mode, no agent-platform needed)
```

For HTTP mode with a live agent-platform:

```bash
cp .env.template .env  # fill in AGENT_PLATFORM_URL + EMPLOYEE_API_URL at minimum
EMPLOYEE_AUTH_DISABLED=true WORKFLOWS_MCP_TRANSPORT=http npm start
# GET http://localhost:3030/health  →  {"status":"ok",...}
```

## Adding a new tool

1. Add an entry to `TOOL_META` in `src/manifest.ts` (description + annotations).
2. Add the tool name to `TOOL_NAMES` in `src/manifest.ts`.
3. Register the tool in `src/index.ts` (follow the `registerList` / `registerRead` pattern).
4. Use `governed(...)` for all RBAC + audit wiring; never call `agentPlatform` directly.
5. Update the `WORKFLOWS_OVERVIEW` constant in `src/index.ts` so the overview resource mentions the new tool (the CI `overview-check` job will fail otherwise).
6. Add the `WORKFLOWS_TOOL_<TOOLNAME>` permission key to the README env-vars table if it needs its own per-tool gate.

## Env vars

Every new env var must be:

- Added to `.env.template` with a comment explaining what it does.
- Added to the README env-vars table.
- Consumed via `loadConfig()` in `src/config.ts` — never read `process.env` directly in tool handlers.

## Semantic search sidecar

The `workflows-mcp-pgvector` sidecar (compose service) holds the embeddings
table. Schema migrations run automatically via `EmbeddingsStore` on first
connect. No manual SQL needed for development.

If you need to wipe the local embeddings and re-sync from scratch:

```bash
docker compose down -v   # drops the named volume
docker compose up -d     # recreates; sync loop re-embeds on next interval
```

## Release

Releases follow the repo's standard `dev → main` PR flow. Bump the version in
`package.json` and `src/index.ts` (`SERVER_VERSION`) together in the same commit.
