/**
 * Turn-trace types — the spine of the CLI's evaluation → enhancement → judging
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
import type { ModelTier, UsageTotals } from "./fleet/types.js";
/**
 * A stage of the turn pipeline, in execution order.
 *
 * Re-exported (not hand-copied) from `@oxagen/agent-engine` — that package is
 * the canonical source of truth for the pipeline's stage machine, since it's
 * the engine that actually emits {@link StageEvent}s. A local duplicate here
 * previously drifted silently out of sync with the engine's union; every place
 * in the CLI that imports `StageKind` from this module (`../agent/trace.js`)
 * keeps working unchanged because this re-export has the same name.
 */
import type { StageKind } from "@oxagen/agent-engine";
export type { StageKind };

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

/** Which candidates the enhancer mined and which actually resolved. */
export interface ContextRetrieval {
  /** Symbol-like candidates queried against the code graph. */
  symbolsQueried: string[];
  /** File-path candidates queried against the code graph. */
  pathsQueried: string[];
  /** Candidates that resolved to something real. */
  resolved: string[];
  /** Candidates that resolved to nothing (no code-graph hit). */
  unresolved: string[];
}

/** What the enhancer added to the prompt before handing it to the executor. */
export interface EnhancementTrace {
  /** The final prompt handed to the executor (refined + injected context). */
  prompt: string;
  /** The injected context block alone (empty when nothing was found). */
  context: string;
  /** Symbol/path tokens that resolved to something in the code graph. */
  resolved: string[];
  /** How many past-work lessons were recalled and injected. */
  lessonCount: number;
  /** Where the injected context came from. */
  source: "none" | "code-graph" | "memory" | "code-graph+memory";
  /** Epoch ms the context-gathering started (verbose turns). */
  startedAt?: number;
  /** Epoch ms the context-gathering finished (verbose turns). */
  finishedAt?: number;
  /** Wall-clock ms spent gathering + injecting context. */
  durationMs?: number;
  /** Per-candidate retrieval breakdown (verbose turns). */
  retrieval?: ContextRetrieval;
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
  /** True when this turn was captured in verbose mode. */
  verbose?: boolean;
}
