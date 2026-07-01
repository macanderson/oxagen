/**
 * taxonomy.ts — the single source of truth for the two-axis memory taxonomy
 * descriptions fed to classification prompts (see docs/specs/two-axis-memory).
 *
 * Both the single-memory classifier (agent.memory.remember) and the bulk
 * document extractor (agent.memory.import.parse) feed these exact bullets to the
 * model, so a change to how a class or kind is defined updates every classifier
 * at once instead of drifting between hand-copied prompt strings.
 *
 * Memory has two axes:
 *   - memory_class = epistemic status (how sure / who may confirm)
 *   - memory_kind  = content domain (what the memory is about)
 */

export const MEMORY_CLASS_GUIDE = [
  "class (epistemic status — the confidence ladder):",
  "- OBSERVATION: something noticed that is not yet an enforced rule. The safe default.",
  "- RULE: a policy the agent should follow going forward. Only choose when it clearly reads as a directive.",
  "  (FACT — a human-confirmed truth — is never chosen by the classifier; it is only reached via explicit promotion.)",
].join("\n");

export const MEMORY_KIND_GUIDE = [
  "kind (content domain — pick the closest):",
  "- FEEDBACK: guidance the user gave about how to work.",
  "- PERFORMANCE: something about speed, cost, or efficiency.",
  "- STYLE: formatting, naming, or presentation conventions.",
  "- PREFERENCE: a chosen option, tool, or approach to prefer.",
  "- VOICE: tone or persona for generated language.",
  "- PROSE: wording or phrasing conventions for written output.",
  "- constraint: a rule, limit, or requirement to respect.",
  "- bug-root-cause: the underlying cause of a defect.",
  "- convention-deviation: a deliberate departure from an established pattern.",
  "- gotcha: a surprising, non-obvious trap tied to the codebase.",
  "- routine-change: a self-evident, low-stakes change or fact.",
].join("\n");
