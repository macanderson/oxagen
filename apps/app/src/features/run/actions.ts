"use server";
// The commands an operator sends to one run (spec §7.3, §7.4, §7.6), through
// the kernel seam for the workspace viewer the URL names.
//
// `dispatch_command` queues; it does not change the run. A pause takes effect
// at the next boundary the harness reaches, a cancel revokes the run token and
// kills the process on a best-effort basis, and a steer reaches the model as a
// control frame. So these return the command ids the contract answered with,
// and the caller says a command was queued rather than that the run stopped.
//
// Steering text is evidence. Oxagen records it, quotes it and hands it to the
// model as content; it is never executed here.
import {
  STEER_TEXT_MAX,
  tachoCommandDispatch,
} from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { runExport } from "@oxagen/oxagen/contracts/run.export";
import { runSummarize } from "@oxagen/oxagen/contracts/run.summarize";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export type QueuedCommand = { commandIds: string[] };

/** Pause at the next boundary, or resume a run paused earlier. The reason reaches the model. */
export async function haltRun(
  org: string,
  ws: string,
  runId: string,
  command: "pause" | "resume" | "cancel",
  reason: string,
): Promise<ActionResult<QueuedCommand>> {
  const ctx = await requireViewer(org, ws);
  const trimmed = reason.trim();
  const result = await kernelWrite(ctx, tachoCommandDispatch, {
    target: { kind: "run", id: runId },
    command,
    ...(trimmed === "" ? {} : { reason: trimmed }),
  });
  return result.ok
    ? { ok: true, value: { commandIds: result.value.commandIds } }
    : result;
}

/** Steer the run: the text reaches the model as a control frame at the delivery mode the connection point can carry. */
export async function steerRun(
  org: string,
  ws: string,
  runId: string,
  text: string,
): Promise<ActionResult<QueuedCommand>> {
  const ctx = await requireViewer(org, ws);
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > STEER_TEXT_MAX) {
    return { ok: false, reason: "invalid", code: "steer_text", field: "text" };
  }
  const result = await kernelWrite(ctx, tachoCommandDispatch, {
    target: { kind: "run", id: runId },
    command: "steer",
    payload: { text: trimmed },
  });
  return result.ok
    ? { ok: true, value: { commandIds: result.value.commandIds } }
    : result;
}

/**
 * Queue the generated name and summary for a sealed run (`summarize_run`,
 * ADR-058). A fast-tier model reads the transcript and writes what changed;
 * the call runs off the request path, so this answers `queued` and the run
 * carries the sentence once the job has written it.
 *
 * A live run and a `digest_only` recording are both refused: the record is not
 * complete in the first case, and there are no bodies to read in the second.
 */
export async function summarizeRun(
  org: string,
  ws: string,
  runId: string,
): Promise<ActionResult<{ runId: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, runSummarize, { runId });
  return result.ok
    ? { ok: true, value: { runId: result.value.runId } }
    : result;
}

/**
 * Queue a signed, offline-verifiable evidence bundle for a sealed run
 * (`export_run`): frame envelopes as NDJSON, the Merkle root, an attestation,
 * the verifying key id and a verifier script. The seal is what the attestation
 * signs, so a live run is refused.
 */
export async function exportRun(
  org: string,
  ws: string,
  runId: string,
): Promise<ActionResult<{ exportId: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, runExport, { runId });
  return result.ok
    ? { ok: true, value: { exportId: result.value.exportId } }
    : result;
}
