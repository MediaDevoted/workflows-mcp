import type { WorkflowSummary } from "./agent-platform.js";

export interface ScoredWorkflow {
  slug: string;
  title: string;
  description: string;
  score: number;
  matched_triggers: string[];
}

export function scoreWorkflow(workflow: WorkflowSummary, query: unknown): ScoredWorkflow {
  // Defensive: callers via mcp-passthrough's execute_tool bypass Zod validation,
  // so `query` can arrive as undefined/null/non-string here.
  const needle = (typeof query === "string" ? query : "").trim().toLowerCase();
  const tokens = needle.split(/\s+/).filter(Boolean);
  const title = (workflow.title ?? "").toLowerCase();
  const description = (workflow.description ?? "").toLowerCase();
  const triggers = (workflow.triggers ?? []).map((t) => t.toLowerCase());

  // When needle is empty, t.includes("") is true for every trigger — we treat
  // that as "no token matches" rather than "all triggers match" so an empty
  // query produces a clean zero-score result.
  const matchedTriggers = needle
    ? triggers.filter((t) => t.includes(needle) || tokens.some((tok) => t.includes(tok)))
    : [];

  let score = 0;
  for (const tok of tokens) {
    if (title.includes(tok)) score += 3;
    if (triggers.some((t) => t.includes(tok))) score += 2;
    if (description.includes(tok)) score += 1;
  }
  if (needle && title.includes(needle)) score += 3;

  return {
    slug: workflow.slug,
    title: workflow.title,
    description: workflow.description,
    score,
    matched_triggers: workflow.triggers?.filter((t) => matchedTriggers.includes(t.toLowerCase())) ?? [],
  };
}
