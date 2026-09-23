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
import { workspaceSettingsWrite } from "@oxagen/oxagen/contracts/workspace.settings.write";
import {
  COMMAND_REASON_MAX,
  STEER_TEXT_MAX,
  tachoCommandDispatch,
} from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { runBisect } from "@oxagen/oxagen/contracts/run.bisect";
import { runExport } from "@oxagen/oxagen/contracts/run.export";
import { runExportGet } from "@oxagen/oxagen/contracts/run.export.get";
import { runFork } from "@oxagen/oxagen/contracts/run.fork";
import { runSummarize } from "@oxagen/oxagen/contracts/run.summarize";
import {
  runTranscriptGet,
  TRANSCRIPT_ENTRY_DEFAULT,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import { moneyFromMicros } from "@/data/contracts/money";
import { DeliveryMode } from "@/data/contracts/runs";
import {
  RunTranscript,
  type TranscriptKind,
  type TranscriptZoom,
} from "@/data/contracts/run";
import type { Read } from "@/data/read";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export type QueuedCommand = { commandIds: string[] };

type RunTranscriptGetOutput = ContractOutput<typeof runTranscriptGet>;

/** Where one run export stands, exactly as `get_run_export` answers it. */
export type RunExportStatus = ContractOutput<typeof runExportGet>;

/**
 * Pause at the next boundary, or resume a run paused earlier. The reason
 * reaches the model, and an empty one is omitted rather than sent as the
 * blank string the contract's `min(1)` would refuse.
 *
 * The reason is held to the contract's own ceiling here, so a long one comes
 * back naming the field a person can shorten instead of as a schema refusal
 * with nothing to point at.
 */
export async function haltRun(
  org: string,
  ws: string,
  runId: string,
  command: "pause" | "resume" | "cancel",
  reason: string,
): Promise<ActionResult<QueuedCommand>> {
  const ctx = await requireViewer(org, ws);
  const trimmed = reason.trim();
  if (trimmed.length > COMMAND_REASON_MAX) {
    return {
      ok: false,
      reason: "invalid",
      code: "command_reason",
      field: "reason",
    };
  }
  const result = await kernelWrite(ctx, tachoCommandDispatch, {
    target: { kind: "run", id: runId },
    command,
    ...(trimmed === "" ? {} : { reason: trimmed }),
  });
  return result.ok
    ? { ok: true, value: { commandIds: result.value.commandIds } }
    : result;
}

/**
 * Steer the run: the text reaches the model as a control frame, at the
 * delivery mode the operator asked for (spec §7.3).
 *
 * `requestedMode` is a ceiling, not a promise. The connection point resolves
 * the strongest mode it can carry at or below it, and the command row records
 * both the request and what was carried, so the caller says when the text can
 * arrive rather than when it will.
 *
 * A server action is an endpoint, so the mode is parsed here rather than
 * trusted from the form: a value outside the three the contract accepts comes
 * back as `delivery_mode` on the field that carried it, not as a schema
 * refusal with no field to point at.
 */
export async function steerRun(
  org: string,
  ws: string,
  runId: string,
  text: string,
  requestedMode: string,
): Promise<ActionResult<QueuedCommand>> {
  const ctx = await requireViewer(org, ws);
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > STEER_TEXT_MAX) {
    return { ok: false, reason: "invalid", code: "steer_text", field: "text" };
  }
  const mode = DeliveryMode.safeParse(requestedMode);
  if (!mode.success) {
    return {
      ok: false,
      reason: "invalid",
      code: "delivery_mode",
      field: "requestedMode",
    };
  }
  const result = await kernelWrite(ctx, tachoCommandDispatch, {
    target: { kind: "run", id: runId },
    command: "steer",
    payload: { text: trimmed, requestedMode: mode.data },
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

/**
 * Read one export back (`get_run_export`): the status its job has reached, the
 * bundle's digest and size once it is built, the job's error if it failed, and
 * a download URL that expires.
 *
 * The export dialog polls this after `export_run` answers an id, so the read
 * happens on demand and resolves its own viewer, as `readTranscriptPage` does.
 * Every read mints a fresh 15-minute download token, which is why the dialog
 * stops polling once the export is ready or failed.
 *
 * A refusal keeps its kind through `readToActionResult`: an export id from
 * another workspace comes back `not_found` with the handler's reason
 * (`run_export_not_found`), and a viewer below Owner or Admin comes back
 * `denied`.
 */
export async function readRunExport(
  org: string,
  ws: string,
  exportId: string,
): Promise<ActionResult<RunExportStatus>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: runExportGet,
    input: { exportId },
    page: "run",
  });
  return readToActionResult(read);
}

/**
 * A read carried in the shape a write's answer takes. Every caller of this
 * module is a client component, and INV-19 has every exported function of a
 * `"use server"` module answer with an `ActionResult`, so a `Read` is carried
 * across rather than returned: `denied` keeps the permission the page failure
 * names, and an error keeps its code. The Repositories page does the same
 * for its on-demand reads; the layer matrix (INV-07) keeps
 * `features/*` out of `data/live`, so each of the two owns its own copy.
 *
 * `invalid_input` becomes `invalid` rather than `unavailable`, because the
 * only input a caller varies here is the cursor: the run, the zoom and the
 * chips come from the page. That is what lets the view say "this resume point
 * is not one the read wrote" instead of "something went wrong".
 */
/**
 * A half or a decision with its subagent chain named as the view model names
 * it (`chainRef`), and nothing named when it was recorded on the run's own.
 */
function chained<T extends { sessionUuid?: string }>(
  value: T | null,
): (Omit<T, "sessionUuid"> & { chainRef?: string }) | null {
  if (value === null) return null;
  const { sessionUuid, ...rest } = value;
  return sessionUuid === undefined ? rest : { ...rest, chainRef: sessionUuid };
}

function toTranscriptPage(
  out: RunTranscriptGetOutput,
): z.input<typeof RunTranscript> {
  const cost = (value: RunTranscriptGetOutput["entries"][number]["cost"]) =>
    value === null
      ? null
      : {
          ...moneyFromMicros(value.micros, value.currency),
          basis: value.basis,
        };
  return {
    zoom: out.zoom,
    kinds: out.kinds,
    entries: out.entries.map((entry) => ({
      seq: entry.seq,
      endSeq: entry.endSeq,
      ...(entry.subagent === undefined
        ? {}
        : {
            subagent: {
              chainRef: entry.subagent.sessionUuid,
              type: entry.subagent.type,
            },
          }),
      at: entry.at,
      elapsedMs: entry.elapsedMs,
      kind: entry.kind,
      type: entry.type,
      label: entry.label,
      callKey: entry.callId,
      usage: entry.usage ?? null,
      kinds: entry.kinds,
      turn: entry.turn,
      request: chained(entry.request),
      response: chained(entry.response),
      decision: chained(entry.decision),
      frames: entry.frames,
      cost: cost(entry.cost),
      cumulativeCost: cost(entry.cumulativeCost),
    })),
    cursor: out.cursor,
    complete: out.complete,
  };
}

function asActionResult<T>(read: Read<T>): ActionResult<T> {
  if (read.ok) return read;
  switch (read.reason) {
    case "denied":
      return { ok: false, reason: "denied", code: read.permission };
    case "pending_approval":
      return {
        ok: false,
        reason: "pending_approval",
        accessRequestId: read.accessRequestId,
      };
    case "error":
      return read.code === "invalid_input"
        ? {
            ok: false,
            reason: "invalid",
            code: "invalid_cursor",
            field: "after",
          }
        : { ok: false, reason: "unavailable", code: read.code };
  }
}

/**
 * One later page of the transcript, for the player's own pagination
 * (`get_run_transcript`).
 *
 * A read that must happen on demand has nowhere else to live (INV-07's
 * `features` row): a page's reads go through a `DataSource` port and are made
 * when the route renders, and a navigation is exactly what appending a page
 * must not cost, because it would throw away the playhead and the scroll
 * position. So this resolves its own viewer and reads through the kernel seam,
 * as a write does.
 *
 * The mapping is the port's, written out here because the layer matrix keeps
 * `features/*` out of `data/live`. `actions.test.ts` holds the two to the same
 * answer for the same contract output, so the first page and a later one
 * cannot come to disagree about one run.
 */
export async function readTranscriptPage(
  org: string,
  ws: string,
  runId: string,
  zoom: TranscriptZoom,
  kinds: readonly TranscriptKind[],
  after: string,
): Promise<ActionResult<RunTranscript>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: runTranscriptGet,
    input: {
      runId,
      zoom,
      kinds: [...kinds],
      limit: TRANSCRIPT_ENTRY_DEFAULT,
      after,
    },
    page: "run",
  });
  if (!read.ok) return asActionResult(read);
  const view = RunTranscript.safeParse(toTranscriptPage(read.value));
  if (view.success) return { ok: true, value: view.data };
  captureError({
    error: view.error,
    source: "app",
    orgId: ctx.orgId,
    context: "readTranscriptPage record_unmappable",
  });
  return { ok: false, reason: "unavailable", code: "record_unmappable" };
}

/**
 * Fork this run from a frame (`fork_run`): frames 0 to N replay from the
 * recording, the next model call runs live, and a tool result after N is
 * served from the cassette when its input digest matches. Oxagen mints the
 * attempt; the harness that admitted the run is what resumes it (ADR-043), so
 * this answers the attempt, not a running agent.
 */
/** @deregistered Retained with the replay UI under ADR-130. */
export async function forkRun(
  org: string,
  ws: string,
  runId: string,
  fromSeq: string,
): Promise<ActionResult<{ attemptId: string; attemptNumber: number }>> {
  const ctx = await requireViewer(org, ws);
  if (!/^\d{1,19}$/.test(fromSeq) || fromSeq === "0") {
    return { ok: false, reason: "invalid", code: "from_seq", field: "fromSeq" };
  }
  const result = await kernelWrite(ctx, runFork, { runId, fromSeq });
  return result.ok
    ? {
        ok: true,
        value: {
          attemptId: result.value.attemptId,
          attemptNumber: result.value.attemptNumber,
        },
      }
    : result;
}

/**
 * The first frame at which this run and another diverge (`bisect_runs`). Both
 * recordings are aligned frame by frame on each frame's kind and call
 * identity; bodies are not read, so this works at grade `inspect` and above.
 */
/** @deregistered Retained with the replay UI under ADR-130. */
export async function bisectRuns(
  org: string,
  ws: string,
  runA: string,
  runB: string,
): Promise<
  ActionResult<{
    divergentSeq: string | null;
    keyA: string | null;
    keyB: string | null;
    aligned: number;
  }>
> {
  const ctx = await requireViewer(org, ws);
  const other = runB.trim();
  if (other === "" || other === runA) {
    return { ok: false, reason: "invalid", code: "run_b", field: "runB" };
  }
  const result = await kernelWrite(ctx, runBisect, { runA, runB: other });
  return result.ok
    ? {
        ok: true,
        value: {
          divergentSeq: result.value.divergentSeq,
          keyA: result.value.keyA,
          keyB: result.value.keyB,
          aligned: result.value.aligned,
        },
      }
    : result;
}

export async function setRunEnrichment(
  org: string,
  ws: string,
  enabled: boolean,
): Promise<ActionResult<ContractOutput<typeof workspaceSettingsWrite>>> {
  const ctx = await requireViewer(org, ws);
  if (typeof enabled !== "boolean")
    return {
      ok: false as const,
      reason: "invalid" as const,
      code: "invalid_enrichment_setting",
    };
  return kernelWrite(ctx, workspaceSettingsWrite, {
    runEnrichmentEnabled: enabled,
  });
}
