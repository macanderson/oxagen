/**
 * Failure → eval distillation (ADR-028): turn a failed or thumbs-downed run
 * into an evals-v1 dataset item, so the exact failures users hit become the
 * regression set the platform scores (and, later, optimizes) against.
 *
 * The item shape is structurally `evalDatasetItemSchema` from
 * `packages/oxagen/src/contracts/eval-schema.ts` ({ input, expectedOutput?,
 * metadata }); declared locally so this package stays platform-independent —
 * the CLI pushes items through the existing governed `eval.*` capabilities.
 */
import { z } from "zod";

export const distillReasonSchema = z.enum(["failed", "thumbs_down", "manual"]);
export type DistillReason = z.infer<typeof distillReasonSchema>;

/** An evals-v1 dataset item (mirror of `evalDatasetItemSchema`). */
export const distilledEvalItemSchema = z.object({
  input: z.string().min(1),
  expectedOutput: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()),
});
export type DistilledEvalItem = z.infer<typeof distilledEvalItemSchema>;

export interface DistillSource {
  sid: string;
  /** The session's original prompt — the eval case's input. */
  prompt: string;
  reason: DistillReason;
  /** Terminal session state (done/failed/cancelled), when known. */
  fate?: string;
  model?: string;
  agent?: string;
  turns: number;
  /** Last fatal/salient error message from the run, when one exists. */
  errorMessage?: string;
  /** The dooming turn, when a bisect identified one. */
  failedTurn?: number;
  changedFiles?: string[];
  feedbackComment?: string;
  cliVersion?: string;
  gitHead?: string;
  /** Epoch-ms the distillation happened (injected for determinism). */
  distilledAt: number;
}

/** The default platform dataset slug distilled fleet failures land in. */
export const DISTILL_DATASET_SLUG = "fleet-distilled-failures";

/**
 * Build the eval item. `input` is the run's original prompt — rerunning it is
 * rerunning the failure. Provenance and failure forensics ride in `metadata`
 * so judges, dashboards, and a future optimizer can slice by model, harness
 * version, or dooming turn.
 */
export function distillEvalItem(source: DistillSource): DistilledEvalItem {
  if (source.prompt.trim() === "") {
    throw new Error("cannot distill a run with an empty prompt");
  }
  const metadata: Record<string, unknown> = {
    source: "fleet_replay",
    sid: source.sid,
    reason: source.reason,
    turns: source.turns,
    distilledAt: source.distilledAt,
  };
  if (source.fate !== undefined) metadata["fate"] = source.fate;
  if (source.model !== undefined) metadata["model"] = source.model;
  if (source.agent !== undefined) metadata["agent"] = source.agent;
  if (source.errorMessage !== undefined)
    metadata["error"] = source.errorMessage;
  if (source.failedTurn !== undefined)
    metadata["failedTurn"] = source.failedTurn;
  if (source.changedFiles && source.changedFiles.length > 0) {
    metadata["changedFiles"] = source.changedFiles;
  }
  if (source.feedbackComment !== undefined)
    metadata["feedback"] = source.feedbackComment;
  if (source.cliVersion !== undefined)
    metadata["cliVersion"] = source.cliVersion;
  if (source.gitHead !== undefined) metadata["gitHead"] = source.gitHead;
  return { input: source.prompt, metadata };
}
