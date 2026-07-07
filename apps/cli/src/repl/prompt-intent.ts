/**
 * Prompt-intent classification for the interactive REPL fast path.
 *
 * The per-turn pipeline (plan → evaluate → enhance → route → execute → judge →
 * revise) is the right altitude for a *coding task* — "fix this across 5 files",
 * "implement X". It is pure overhead for a *conversational lookup* — "what's the
 * command to add an MCP server?". Such a turn needs grounded retrieval (the
 * code-graph + docs the enhance stage already provides) and a single answer, not
 * a dedicated planner model call up front and a frontier completeness judge on
 * the back.
 *
 * This classifier is a zero-cost heuristic (no LLM call): it inspects only the
 * prompt text and decides `"simple"` vs `"task"`. It is deliberately
 * CONSERVATIVE toward `"task"` — a false "simple" is the costlier error (a real
 * task would skip planning), while a false "task" only loses the fast path. The
 * downstream judge-skip is additionally guarded on a zero diff (see
 * `pipeline/index.ts`), so a misclassified prompt that *does* edit files still
 * gets judged — classification accuracy only gates the cheap planner skip.
 */

/** Leading interrogatives that mark an informational question. */
const INTERROGATIVE_LEAD =
  /^(what|what's|whats|how|how's|hows|where|where's|wheres|why|which|who|who's|whos|when|whose)\b/i;

/** Leading yes/no auxiliaries that also mark a question ("is X…", "can I…"). */
const AUX_LEAD =
  /^(is|are|am|was|were|do|does|did|can|could|should|would|will|shall|may|might|have|has|had)\b/i;

/**
 * Leading imperative verbs that mark a mutation task. Matched only at the START
 * of the prompt so "what is the command to ADD an mcp server" (interrogative
 * lead) is NOT captured — the leading interrogative wins, which is exactly the
 * case that motivated the fast path.
 */
const IMPERATIVE_LEAD =
  /^(add|create|make|build|implement|write|edit|change|update|modify|fix|refactor|rename|move|delete|remove|install|set|setup|configure|generate|scaffold|migrate|run|deploy|bump|upgrade|downgrade|revert|merge|rebase|commit|push|wire|hook|replace|rewrite|extract|inline|split|test|lint|format)\b/i;

/**
 * Explicit "you do it" phrasings that flip an otherwise question-shaped prompt
 * back to a task ("can you add …", "could you implement …").
 */
const DELEGATION = /\b(can|could|would|will)\s+you\b|\bplease\s+(add|create|make|fix|implement|update|write|change|build|run|set)\b/i;

/**
 * A prompt is a `"simple"` lookup when it reads as an informational question and
 * carries no "you do it" delegation. Everything else — imperatives, delegated
 * requests, and anything ambiguous — stays a `"task"` and runs the full
 * pipeline.
 */
export function classifyPromptIntent(prompt: string): "simple" | "task" {
  const text = prompt.trim();
  if (!text) return "task";

  // A first line that reads as a question is the strongest signal. Use the first
  // line so a multi-line paste ("what's the flag?\n\n<log dump>") still reads as
  // a question off its opening clause.
  const firstLine = text.split(/\r?\n/, 1)[0]!.trim();

  // Delegation ("can you add…") is a task even though it starts with an aux.
  if (DELEGATION.test(text)) return "task";

  const leadsInterrogative = INTERROGATIVE_LEAD.test(firstLine);
  const leadsAux = AUX_LEAD.test(firstLine);
  const endsQuestion = firstLine.endsWith("?") || text.endsWith("?");

  // Imperative lead ("add the filesystem mcp …") is a task unless the prompt is
  // clearly a question ("add or remove — which is faster?" is rare; the leading
  // imperative dominates, so treat it as a task).
  if (IMPERATIVE_LEAD.test(firstLine) && !leadsInterrogative) return "task";

  if (leadsInterrogative) return "simple";
  // A yes/no auxiliary lead only counts as a question when it actually reads as
  // one (ends with "?") — "is" can also start a statement fragment.
  if (leadsAux && endsQuestion) return "simple";
  // A bare question mark with no imperative lead (already returned above) is a
  // question too ("the mcp add command?").
  if (endsQuestion) return "simple";

  return "task";
}
