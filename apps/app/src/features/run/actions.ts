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
//
// A later transcript page is read here too, through the `runs.transcript`
// port rather than the kernel seam, so the Run page maps every page of a
// transcript with one mapper (ADR-167, ADR-182).
import { agentInterjectionAnswer } from "@oxagen/oxagen/contracts/agent.interjection.answer";
import { workspaceSettingsWrite } from "@oxagen/oxagen/contracts/workspace.settings.write";
import {
  COMMAND_REASON_MAX,
  STEER_TEXT_MAX,
  tachoCommandDispatch,
} from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { runBisect } from "@oxagen/oxagen/contracts/run.bisect";
import { runExport } from "@oxagen/oxagen/contracts/run.export";
import { runExportGet } from "@oxagen/oxagen/contracts/run.export.get";
import { runSeal } from "@oxagen/oxagen/contracts/run.seal";
import { runFork } from "@oxagen/oxagen/contracts/run.fork";
import { runSummarize } from "@oxagen/oxagen/contracts/run.summarize";
import { TRANSCRIPT_ENTRY_DEFAULT } from "@oxagen/oxagen/contracts/run.transcript.get";
import { z } from "zod";
import type {
  RunTranscript,
  TranscriptKind,
  TranscriptText,
  TranscriptZoom,
} from "@/data/contracts/run";
import { DeliveryMode } from "@/data/contracts/runs";
import { dataSource } from "@/data/source";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export type QueuedCommand = { commandIds: string[] };

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

/** What sealing a run did, exactly as `seal_run` answers it. */
export type SealedRun = ContractOutput<typeof runSeal>;

/**
 * Seal a wrapped run the control plane still reads as live, and queue a kill
 * for its agent on its host when the host can collect one (`seal_run`,
 * ADR-169). The seal is final. The answer says whether the kill was queued,
 * so the dialog never claims the agent stopped when no host could be told.
 *
 * The reason is held to the contract's ceiling here, as a halt's is, so a
 * long one names the field rather than coming back as a schema refusal.
 */
export async function sealRun(
  org: string,
  ws: string,
  runId: string,
  reason: string,
): Promise<ActionResult<SealedRun>> {
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
  return kernelWrite(ctx, runSeal, {
    runId,
    ...(trimmed === "" ? {} : { reason: trimmed }),
  });
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
 * One page of the transcript read on demand (`get_run_transcript`): the page
 * past a cursor, for the player's own pagination, or the first page of a
 * search, which the server runs over the whole run (ADR-182).
 *
 * The read happens on demand: a navigation would throw away the playhead and
 * the scroll position, so appending a page cannot wait for the route to
 * render. It resolves its own viewer and reads the `runs.transcript` port, the
 * same read and the same mapper the first page goes through, so a later page
 * carries everything the first one does, the assembled reply included (ADR-167,
 * ADR-182).
 *
 * A read the contract refuses comes back as `invalid` on the input the
 * caller varied: `after` when it sent a cursor, which the capability did not
 * write, and `query` when it sent only a search, which the contract bounds.
 * That is what lets the view say "this resume point is not one the read
 * wrote" instead of "something went wrong". Every other refusal keeps the
 * kind and code the port answered.
 */
export async function readTranscriptPage(
  org: string,
  ws: string,
  runId: string,
  zoom: TranscriptZoom,
  q: {
    kinds?: readonly TranscriptKind[];
    after?: string;
    text?: TranscriptText;
    query?: string;
  },
): Promise<ActionResult<RunTranscript>> {
  const ctx = await requireViewer(org, ws);
  const read = await dataSource().runs.transcript(ctx, runId, zoom, {
    kinds: [...(q.kinds ?? [])],
    limit: TRANSCRIPT_ENTRY_DEFAULT,
    ...(q.after === undefined ? {} : { after: q.after }),
    ...(q.text === undefined ? {} : { text: q.text }),
    ...(q.query === undefined ? {} : { query: q.query }),
  });
  if (!read.ok && read.reason === "error" && read.code === "invalid_input") {
    return q.after === undefined
      ? { ok: false, reason: "invalid", code: "invalid_query", field: "query" }
      : {
          ok: false,
          reason: "invalid",
          code: "invalid_cursor",
          field: "after",
        };
  }
  return readToActionResult(read);
}

/**
 * Fork this run from a frame (`fork_run`): frames 0 to N replay from the
 * recording, the next model call runs live, and a tool result after N is
 * served from the cassette when its input digest matches. Oxagen mints the
 * attempt; the harness that admitted the run is what resumes it (ADR-043), so
 * this answers the attempt, not a running agent.
 */
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

/** What answering a question did, exactly as `answer_interjection` answers it. */
export type AnsweredInterjection = ContractOutput<
  typeof agentInterjectionAnswer
>;

/**
 * The two answers a person can give a repository question: link the
 * repository to the workspace the host named, or create a workspace for it
 * under the name and slug the person typed.
 */
export type InterjectionChoice =
  | { path: "link" }
  | { path: "create"; name: string; slug: string };

const Choice = z.discriminatedUnion("path", [
  z.object({ path: z.literal("link") }).strict(),
  z
    .object({ path: z.literal("create"), name: z.string(), slug: z.string() })
    .strict(),
]);

/**
 * Answer the question a host held this run on (`answer_interjection`,
 * #3941). The answer is one governed write: it links the repository or
 * creates the workspace, records the answer on the question with a receipt,
 * and queues the release the host reads to let the run go on.
 *
 * A server action is an endpoint, so the choice is parsed here rather than
 * trusted from the page: anything but the two shapes comes back as `invalid`
 * on `path` before the kernel runs. The name and slug are trimmed and then
 * left to the contract, which `kernelWrite` parses before the handler runs,
 * so a slug the contract refuses comes back naming `create.slug`. Every
 * refusal the handler makes keeps its reason as the code: someone answered
 * first, the run stopped waiting, or the viewer's role cannot link or create.
 */
export async function answerInterjection(
  org: string,
  ws: string,
  interjectionId: string,
  choice: InterjectionChoice,
): Promise<ActionResult<AnsweredInterjection>> {
  const ctx = await requireViewer(org, ws);
  const parsed = Choice.safeParse(choice);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      code: "interjection_choice",
      field: "path",
    };
  }
  const picked = parsed.data;
  return kernelWrite(
    ctx,
    agentInterjectionAnswer,
    picked.path === "create"
      ? {
          interjectionId,
          path: "create",
          create: { name: picked.name.trim(), slug: picked.slug.trim() },
        }
      : { interjectionId, path: "link" },
  );
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
