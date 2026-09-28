/**
 * prompts.ts — the operator prompts a findings pass reads for detector 6,
 * prompt habits. No I/O: ../findings-prompts.ts reads them from the
 * `turn_start` frames on each run's own chain, and the prompt text from the
 * evidence store when the workspace keeps it.
 */
import type { PricedRequestFrame } from "./shared";

/**
 * What the workspace keeps of a prompt. `content_exact` keeps the text, so
 * the detector clusters sentences. `digest_only` keeps the whole prompt's
 * digest alone, so the detector can only match whole prompts.
 */
export type PromptTextMode = "content_exact" | "digest_only";

/** One prompt an operator sent into a run, on the run's own chain. */
export interface RunPrompt {
  /** The run's public id (`tse_…`). */
  runId: string;
  /** The prompt frame's position on the run's own chain. */
  seq: number;
  at: Date;
  /** `at` in microseconds since the epoch, from the store's own text. */
  atMicros?: number;
  /** `sha256:<hex>` over the whole prompt text, as the hook recorded it. */
  digest: string;
  /** The prompt's length in characters; null when the hook recorded none. */
  length: number | null;
  /** The prompt text; null when the workspace keeps none or the body did not read back. */
  text: string | null;
}

/** The prompts of a pass's window, with the frames that price them. */
export interface PromptRead {
  mode: PromptTextMode;
  prompts: readonly RunPrompt[];
  /**
   * The priced model-call frames on the run's own chain, by run public id,
   * for the runs the reader priced. A run absent here has its prompts cited
   * but not covered.
   */
  frames: ReadonlyMap<string, readonly PricedRequestFrame[]>;
}
