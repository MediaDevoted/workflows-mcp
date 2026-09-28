# workflows-mcp (retired)

This legacy service was retired on 28 September 2026. Its production container is
stopped with restart disabled, and the compose file no longer defines the old
application. MD Agent now owns tasks, workflows and approvals; Employee API owns
employee identity and permissions. The new dashboard is at `/agents`.

Source history is retained for recovery. Do not re-enable the old service against
the new API. Workflows' historical database is retained; no data volume is deleted.
