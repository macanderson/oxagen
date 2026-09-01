/**
 * Turn-trace types — the spine of the evaluation → enhancement → judging
 * pipeline and the data the `/replay` command renders.
 *
 * Every user prompt becomes a {@link TurnTrace}: what the user typed, how the
 * cheap evaluator scored it, the context the enhancer injected, which model was
 * selected and why, what the advisor judge concluded about completeness, and the
 * full chain of thought from each stage. The trace is persisted so the whole
 * process stays inspectable after the fact — nothing about how the agent reached
 * its answer is hidden from the user.
 *
 * These types are framework-free (no Ink, no AI SDK) so the engine, the store,
 * and their tests never import a renderer or hit the gateway.
 */
import type { ModelTier, UsageTotals } from "../types";
import type { MutationGateResult } from "../verify/mutation";

// Re-export for consumers that only import from this module.
export type { ModelTier, UsageTotals };

/** A stage of the turn pipeline, in execution order. */
export type StageKind =
  | "evaluate" // the cheap model scored the prompt
  | "plan" // the goal was decomposed into an executable task plan
  | "enhance" // code-graph + memory context was injected
  | "route" // the executor model was selected
  | "execute" // the coding agent ran
  | "judge" // the advisor checked the work for completeness
  | "revise" // the agent was sent back to finish incomplete work
  | "complete"; // the turn finished

/**
 * A live progress event the pipeline emits at each stage so the REPL can show
 * the user exactly what is happening, in real time.
 */
export interface StageEvent {
  kind: StageKind;
  /** One-line, human-readable label for the status stream. */
  label: string;
  /** Optional extra detail (a model slug, a score, a verdict). */
  detail?: string;
}

/**
 * A pre-execution snapshot of the work about to run — surfaced after ROUTE and
 * before EXECUTE so a caller can show the user the enhanced prompt + estimated
 * cost, and optionally gate execution behind a confirmation.
 */
export interface ScopeReviewInfo {
  /** The user's original prompt, verbatim. */
  originalPrompt: string;
  /** The evaluator's noise-removed rewrite (equals originalPrompt when no refine happened). */
  refinedPrompt: string;
  /** The final prompt handed to the executor (refined + injected context). */
  enhancedPrompt: string;
  /** The injected context block alone (empty when nothing was retrieved). */
  context: string;
  /** The routed executor model slug. */
  model: string;
  /** The routed model tier. */
  tier: ModelTier;
  /** Rough pre-flight input-token estimate (heuristic). */
  estimatedInputTokens: number;
  /** Rough pre-flight output-token estimate (heuristic). */
  estimatedOutputTokens: number;
  /** Rough pre-flight dollar estimate from the rate card (heuristic). */
  estimatedCostUsd: number;
}

/** A caller's decision at the scope-review gate. */
export type ScopeReviewDecision =
  | { proceed: true; prompt?: string } // run; optional edited prompt replaces the enhanced prompt
  | { proceed: false }; // cancel before any execution

/**
 * The cheap model's read of the user's prompt: how complete and how complex it
 * is, what context to pull, and a noise-removed rewrite.
 */
export interface PromptEvaluation {
  /** 0–100: how complete/actionable the prompt is on its own. */
  completeness: number;
  /** 0–100: how much work / risk / blast-radius the request implies. */
  complexity: number;
  /** Tier the evaluator recommends for the work. */
  recommendedTier: ModelTier;
  /** Information the prompt is missing (empty when it is self-contained). */
  missing: string[];
  /** Symbols / file paths / topics worth retrieving from the code graph. */
  contextQueries: string[];
  /** The prompt rewritten: filler removed, intent sharpened, meaning preserved. */
  refinedPrompt: string;
  /** What was pruned from the original prompt, and (briefly) why. */
  removed: string[];
  /** The evaluator's chain of thought. */
  reasoning: string;
  /** True when the scores came from the heuristic fallback (model unavailable). */
  fallback: boolean;
  /** Model slug used for the evaluation. */
  model: string;
  usage: UsageTotals;
}

/** What the enhancer added to the prompt before handing it to the executor. */
export interface EnhancementTrace {
  /** The final prompt handed to the executor (refined + injected context). */
  prompt: string;
  /** The injected context block alone (empty when nothing was found). */
  context: string;
  /** How many past-work lessons were recalled and injected. */
  lessonCount: number;
  /** Where the injected context came from. */
  source: "none" | "memory";
  /** Epoch ms the context-gathering started (verbose turns). */
  startedAt?: number;
  /** Epoch ms the context-gathering finished (verbose turns). */
  finishedAt?: number;
  /** Wall-clock ms spent gathering + injecting context. */
  durationMs?: number;
}

/**
 * Timing + model + cost for one pipeline phase — the headline of verbose mode.
 * One per phase occurrence (so each execute/judge revision round gets its own).
 */
export interface PhaseStat {
  /** Which phase: evaluate | enhance | route | execute | judge. */
  phase: StageKind;
  /** Round index for repeated phases (execute/judge); 0 for single-shot phases. */
  round: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** The model that did this phase's work (absent for non-LLM phases). */
  model?: string;
  /** Tokens + dollar cost attributable to this phase (zero for non-LLM phases). */
  usage: UsageTotals;
}

/** One tool invocation: what was called, with what, what came back, how long. */
export interface ToolEvent {
  name: string;
  /** Tool input, JSON-stringified and truncated. */
  input: string;
  /** Tool result, JSON-stringified and truncated (verbose turns). */
  result?: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** False when the tool reported an error. */
  ok: boolean;
}

/** The advisor judge's verdict on whether the agent's work is actually done. */
export interface JudgeVerdict {
  /** True only when every part of the request was addressed with real changes. */
  complete: boolean;
  /** 0–100 confidence in the verdict. */
  confidence: number;
  /** Concrete gaps the judge found (empty when complete). */
  findings: string[];
  /** What the agent still needs to do (empty when complete). */
  remainingWork: string[];
  /** The judge's chain of thought. */
  reasoning: string;
  /** Model slug used for the judgement — always distinct from the executor. */
  model: string;
  /** True when the verdict came from the heuristic fallback (model unavailable). */
  fallback: boolean;
  usage: UsageTotals;
}

/**
 * The complete record of one turn through the pipeline. Persisted by the trace
 * store and rendered by `/replay`.
 */
export interface TurnTrace {
  id: string;
  createdAt: number;
  cwd: string;
  /** Exactly what the user typed, verbatim. */
  originalPrompt: string;
  evaluation: PromptEvaluation;
  enhancement: EnhancementTrace;
  /** Concrete gateway model slug chosen for execution. */
  selectedModel: string;
  /** Tier of the selected executor model. */
  selectedTier: ModelTier;
  /** One-line reason the executor model was chosen. */
  selectionRationale: string;
  /** The agent's final assistant text (truncated for storage). */
  response: string;
  /** Relative paths the agent wrote or edited, from tool activity. */
  filesTouched: string[];
  /** Shell commands the agent ran, from tool activity. */
  commandsRun: string[];
  /** One verdict per judge round; index 0 is the initial completeness check. */
  judgeRounds: JudgeVerdict[];
  /** Whether the pipeline drove the agent to a state the judge calls complete. */
  finalComplete: boolean;
  /** Tool-loop steps taken across all execution rounds. */
  steps: number;
  /** Token + cost totals across evaluator + executor + judge calls. */
  usage: UsageTotals;
  durationMs: number;
  /**
   * Per-phase timing + model + token/cost breakdown. Present on verbose turns;
   * lets you see exactly which model spent which dollars on which phase (enhance
   * vs work vs review) and how long each took. Optional for backward-compat.
   */
  phases?: PhaseStat[];
  /** Every tool call + result with timing (verbose turns). */
  toolEvents?: ToolEvent[];
  /**
   * Mutation-gate verdicts, one per judged-complete round the gate examined
   * (usually exactly one). Records whether the turn's tests actually FAIL
   * without the fix ("witnessed"), still pass without it ("vacuous" — the
   * verdict was overridden into a revise round), or the gate stepped aside
   * ("skipped", with the reason). Optional for backward-compat with stored
   * traces.
   */
  mutationGates?: MutationGateResult[];
  /**
   * The model's reasoning / chain-of-thought, captured per execution round.
   * Persisting it makes the agent's thinking inspectable in `/replay`, and is
   * the substrate for mining durable lessons (a wrong assumption the model
   * voiced) into memory candidates. Each round's text is truncated for storage.
   */
  thinkingLog?: Array<{ round: number; text: string }>;
  /** True when this turn was captured in verbose mode. */
  verbose?: boolean;
}
