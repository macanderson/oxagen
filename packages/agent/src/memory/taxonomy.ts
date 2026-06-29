/**
 * taxonomy.ts — the single source of truth for the AgentMemory kind + weight
 * taxonomy descriptions used in classification prompts.
 *
 * Both the single-memory classifier (agent.memory.remember) and the bulk
 * document extractor (agent.memory.import.parse) feed these exact bullets to the
 * model, so a change to how a kind or weight is defined updates every classifier
 * at once instead of drifting between hand-copied prompt strings.
 */

export const MEMORY_KIND_GUIDE = [
  "kind:",
  "- routine-change: a self-evident, low-stakes change or fact.",
  "- constraint: a rule, limit, or requirement the agent must respect going forward.",
  "- bug-root-cause: the underlying cause of a defect.",
  "- convention-deviation: a deliberate departure from an established pattern.",
  "- gotcha: a surprising, non-obvious trap tied to the codebase.",
].join("\n");

export const MEMORY_WEIGHT_GUIDE = [
  "weight:",
  "- low: routine and self-evident; fine if it rarely surfaces.",
  "- high: a real lesson the agent should usually see before acting.",
  "- critical: must never be forgotten (security, data-loss, production incident).",
].join("\n");
