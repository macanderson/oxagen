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

/** A stage of the turn pipeline, in execution order. */
export type StageKind =
  | "evaluate" // the cheap model scored the prompt
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
  /** Symbol/path tokens that resolved to something in the code graph. */
  resolved: string[];
  /** How many past-work lessons were recalled and injected. */
  lessonCount: number;
  /** Where the injected context came from. */
  source: "none" | "code-graph" | "memory" | "code-graph+memory";
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
}
