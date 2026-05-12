#!/usr/bin/env bash
# ci/check-overview-tools.sh
# Verify the MCP's overview resource mentions every registered tool name.
#
# Exits 0 if every tool registered via `server.tool("<name>", ...)` (across
# any reasonable formatting) appears at least once in the text of the
# `*://overview` server.resource block. Exits 1 otherwise.
#
# Rationale: when a tool is added to the registry but not mentioned in
# the primer doc, capable LLMs build incomplete mental maps and refuse
# to use the tool on follow-up turns. See voluum-mcp PR #1 and
# textyou-mcp PR #1 for the original incidents.

set -eu

SRC="src/index.ts"
if [ ! -f "$SRC" ]; then
  echo "::error::$SRC not found — expected at repo root"
  exit 2
fi

# Pull every tool name. `server.tool(` is often followed by the name on
# the next line; flatten with awk so a single grep can find it.
TOOL_NAMES=$(awk '
  /server\.tool\(/ {
    # Collect until we see the first "<name>",
    line = $0
    while (line !~ /"[a-z][a-z0-9_]+"/) {
      if ((getline next_line) <= 0) break
      line = line " " next_line
    }
    if (match(line, /server\.tool\([[:space:]]*"([a-z][a-z0-9_]+)"/, arr)) {
      print arr[1]
    } else if (match(line, /"([a-z][a-z0-9_]+)"/, arr)) {
      print arr[1]
    }
  }
' "$SRC" 2>/dev/null | sort -u)

# Fallback if awk doesn't support the gensub/match-with-array form
# (BSD awk on macOS lacks the third arg to match). Use perl as a portable
# alternative if the awk pass returned nothing.
if [ -z "$TOOL_NAMES" ]; then
  TOOL_NAMES=$(perl -0777 -ne '
    while (/server\.tool\(\s*"([a-z][a-z0-9_]+)"/sg) { print "$1\n" }
  ' "$SRC" | sort -u)
fi

if [ -z "$TOOL_NAMES" ]; then
  echo "::warning::No tools registered in $SRC — skipping check"
  exit 0
fi

TOOL_COUNT=$(echo "$TOOL_NAMES" | wc -l | tr -d ' ')

# Overview resource text — from its uri declaration to the closing `);`.
OVERVIEW=$(awk '
  /[a-z][a-z0-9_-]*:\/\/overview/ { capturing=1 }
  capturing { print }
  capturing && /^\);?$/ { exit }
' "$SRC")

if [ -z "$OVERVIEW" ]; then
  echo "::warning::No *://overview resource found in $SRC — skipping check"
  exit 0
fi

MISSING=""
MISSING_COUNT=0
for tool in $TOOL_NAMES; do
  if ! echo "$OVERVIEW" | grep -qF "$tool"; then
    MISSING="$MISSING $tool"
    MISSING_COUNT=$((MISSING_COUNT + 1))
  fi
done

if [ "$MISSING_COUNT" -gt 0 ]; then
  echo "::error::Overview is missing $MISSING_COUNT of $TOOL_COUNT registered tools:"
  for tool in $MISSING; do
    echo "  - $tool"
  done
  echo
  echo "Each registered tool must be mentioned (typically in backticks) at"
  echo "least once in the *://overview resource. When the overview omits a"
  echo "tool, capable LLMs build incomplete mental maps and refuse to use"
  echo "the tool on follow-up turns. Fix: add the tool name(s) to the"
  echo "overview text, ideally grouped by category."
  exit 1
fi

echo "✓ Overview mentions all $TOOL_COUNT registered tools"
