## Summary

<!--
What does this PR do? One paragraph is fine.
For new tools: describe the tool name, permission key, and what it does.
For bug fixes: describe the symptom and root cause.
-->

## Type of change

- [ ] Bug fix
- [ ] New tool / feature
- [ ] Refactor / internal cleanup
- [ ] Docs / config only
- [ ] Dependency update

## Testing

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (contract suite + workflow-search-trim tests)
- [ ] Manually tested against a running agent-platform instance (if applicable)

## Checklist

- [ ] New env vars added to `.env.template` and the README env-vars table
- [ ] New tools added to `TOOL_META` in `src/manifest.ts` (description + annotations)
- [ ] `TOOL_NAMES` array in `src/manifest.ts` updated (required for contract suite)
- [ ] Overview resource in `src/index.ts` updated to mention any new tools
- [ ] No source files, lockfiles, or Dockerfiles modified unintentionally
