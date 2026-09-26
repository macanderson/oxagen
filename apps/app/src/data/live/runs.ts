// The runs port on the kernel (ARCHITECTURE.md §3.3): one cursor page of
// list_runs for the Fleet table, and the Run page's reads (get_run,
// get_run_cost, get_run_transcript, and get_run_turns for the Cost tab).
// Every one is a noBillingGate read, so no page load is refused for lack of
// GAUs, and each is mapped into its view model at the boundary.
//
// `list_commands` is the delivery report (#2953): one run's commands, read
// for the Run page's report dialog and a control frame's inspector, or the
// commands one broadcast queued, read by their ids.
//
// `get_run_chain` is its own read because it walks the recording: it belongs
// to the Chain and seal tab and is made only when that tab is open, so the
// long poll on `get_run` never pays for a gap walk nobody asked for.
//
// `get_run` is called with `waitMs: 0`: the page renders one frames page per
// request, and the long poll the contract offers belongs to the stream, not to
// a server render that would hold the response open for it (§3.5). It asks
// for `FRAME_PAGE` frames by name, because the mapper needs the size it asked
// for to tell a full page from the end of the recording.
import "server-only";
import { runChainGet } from "@oxagen/oxagen/contracts/run.chain.get";
import { runCostGet } from "@oxagen/oxagen/contracts/run.cost";
import { runFrameBodyGet } from "@oxagen/oxagen/contracts/run.frame_body.get";
import { FRAME_LIMIT_DEFAULT, runGet } from "@oxagen/oxagen/contracts/run.get";
import { runList } from "@oxagen/oxagen/contracts/run.list";
import { runTurnsGet } from "@oxagen/oxagen/contracts/run.turns.get";
import { runWorkGet } from "@oxagen/oxagen/contracts/run.work.get";
import {
  LIST_COMMANDS_IDS_MAX,
  tachoCommandList,
} from "@oxagen/oxagen/contracts/tacho.command.list";
import { runOutcomesSettingsGet } from "@oxagen/oxagen/contracts/run.outcomes.settings.get";
import { RunWork, RunOutcomesPolicy } from "@/data/contracts/run-work";
import { runOutputsGet } from "@oxagen/oxagen/contracts/run.outputs.get";
import {
  runTranscriptGet,
  TRANSCRIPT_ENTRY_DEFAULT,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  RunChain,
  RunCost,
  RunDetail,
  RunFrameBody,
  RunOutputs,
  RunTranscript,
  RunTurns,
} from "@/data/contracts/run";
import { CommandReport, RunPage } from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
  toCommandReport,
  toRunChain,
  toRunCost,
  toRunDetail,
  toRunFrameBody,
  toRunOutputs,
  toRunTranscript,
  toRunTurns,
} from "./mappers/run";
import { toRunListInput } from "./mappers/run-list-input";
import { toRunPage } from "./mappers/runs";

/** Frames per page of the Frames tab: the contract's own default, named so the mapper can see it. */
const FRAME_PAGE = FRAME_LIMIT_DEFAULT;

/**
 * The most commands one report reads for a run: the contract's ceiling, so a
 * control frame's inspector finds its command among a run's recent ones.
 */
const RUN_REPORT_LIMIT = 100;

/**
 * Orders commands newest first, then by id descending: the order the
 * list_commands handler reads in, so a report merged from several reads keeps
 * the order one read would give.
 */
function newestFirst(
  a: { issuedAt: string; id: string },
  b: { issuedAt: string; id: string },
): number {
  if (a.issuedAt !== b.issuedAt) return a.issuedAt < b.issuedAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** The mapped value parsed at the boundary; a record the view refuses is `record_unmappable`, reported once. */
function view<S extends z.ZodType>(
  orgId: string,
  schema: S,
  mapped: z.input<S>,
  read: string,
): Read<z.output<S>> {
  const parsed = schema.safeParse(mapped);
  if (parsed.success) return readOk(parsed.data);
  captureError({
    error: parsed.error,
    source: "app",
    orgId,
    context: `${read} record_unmappable`,
  });
  return readError("record_unmappable", 502);
}

export const runs: DataSource["runs"] = {
  async outcomesSettings(ctx) {
    const read = await kernelRead(ctx, {
      contract: runOutcomesSettingsGet,
      input: {},
      page: "run",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      RunOutcomesPolicy,
      read.value,
      "runs.outcomesSettings",
    );
  },
  async work(ctx, runId) {
    const read = await kernelRead(ctx, {
      contract: runWorkGet,
      input: { runId },
      page: "run",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      RunWork,
      {
        ...read.value,
        checkouts: read.value.checkouts.map(({ id, ...checkout }) => ({
          ...checkout,
          ref: id,
        })),
        diffs: read.value.diffs.map(({ checkoutId, ...diff }) => ({
          ...diff,
          checkoutRef: checkoutId,
        })),
        pullRequests: read.value.pullRequests.map(({ checkoutIds, ...pr }) => ({
          ...pr,
          checkoutRefs: checkoutIds,
        })),
        subagents: read.value.subagents.map(({ id, ...subagent }) => ({
          ...subagent,
          agentRef: id,
        })),
      },
      "runs.work",
    );
  },
  async list(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: runList,
      input: toRunListInput(q),
      page: "fleet",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, RunPage, toRunPage(read.value), "runs.list");
  },
  async get(ctx, runId, q) {
    const read = await kernelRead(ctx, {
      contract: runGet,
      input:
        q.framesAfter === null
          ? { runId, frameLimit: FRAME_PAGE, waitMs: 0 }
          : {
              runId,
              framesAfter: q.framesAfter,
              frameLimit: FRAME_PAGE,
              waitMs: 0,
            },
      page: "run",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      RunDetail,
      toRunDetail(read.value, FRAME_PAGE),
      "runs.get",
    );
  },
  async frameBody(ctx, runId, seq) {
    const read = await kernelRead(ctx, {
      contract: runFrameBodyGet,
      input: { runId, seq },
      page: "run",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      RunFrameBody,
      toRunFrameBody(seq, read.value),
      "runs.frameBody",
    );
  },
  async cost(ctx, runId) {
    const read = await kernelRead(ctx, {
      contract: runCostGet,
      input: { runId },
      page: "run",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, RunCost, toRunCost(read.value), "runs.cost");
  },
  async turns(ctx, runId) {
    const read = await kernelRead(ctx, {
      contract: runTurnsGet,
      input: { runId },
      page: "run",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, RunTurns, toRunTurns(read.value), "runs.turns");
  },
  async transcript(ctx, runId, zoom, q) {
    const read = await kernelRead(ctx, {
      contract: runTranscriptGet,
      input: {
        runId,
        zoom,
        kinds: q?.kinds ?? [],
        limit: q?.limit ?? TRANSCRIPT_ENTRY_DEFAULT,
        // Omitted rather than null: the contract refuses a cursor it did not
        // write, and `undefined` is what "read from the start" means there.
        ...(q?.after ? { after: q.after } : {}),
        ...(q?.text === undefined ? {} : { text: q.text }),
        ...(q?.query === undefined ? {} : { query: q.query }),
      },
      page: "run",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      RunTranscript,
      toRunTranscript(read.value),
      "runs.transcript",
    );
  },
  async outputs(ctx, runId) {
    const read = await kernelRead(ctx, {
      contract: runOutputsGet,
      input: { runId },
      page: "run",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      RunOutputs,
      toRunOutputs(read.value),
      "runs.outputs",
    );
  },
  async commands(ctx, q) {
    if ("runId" in q) {
      const read = await kernelRead(ctx, {
        contract: tachoCommandList,
        input: { runId: q.runId, limit: RUN_REPORT_LIMIT },
        page: "run",
      });
      if (!read.ok) return read;
      return view(
        ctx.orgId,
        CommandReport,
        toCommandReport(read.value),
        "runs.commands",
      );
    }
    // A broadcast can queue more commands than one read may name: up to 100
    // agents, each with any number of runs in flight. So the ids are read in
    // slices of the contract's ceiling, each asking for one row per id (the
    // contract's default of 50 would cut a slice short), and the first
    // refusal answers for the report.
    const slices: string[][] = [];
    for (let at = 0; at < q.commandIds.length; at += LIST_COMMANDS_IDS_MAX)
      slices.push(q.commandIds.slice(at, at + LIST_COMMANDS_IDS_MAX));
    const reads = await Promise.all(
      slices.map((commandIds) =>
        kernelRead(ctx, {
          contract: tachoCommandList,
          input: { commandIds, limit: commandIds.length },
          page: "run",
        }),
      ),
    );
    for (const read of reads) if (!read.ok) return read;
    // Each slice answers newest first, then by id descending, and the report
    // keeps that order across slices. One broadcast issues its commands in one
    // write, so ties on issuedAt are common.
    const commands = reads
      .flatMap((read) => (read.ok ? read.value.commands : []))
      .sort(newestFirst);
    return view(
      ctx.orgId,
      CommandReport,
      toCommandReport({ commands }),
      "runs.commands",
    );
  },
  async chain(ctx, runId) {
    const read = await kernelRead(ctx, {
      contract: runChainGet,
      input: { runId },
      page: "run",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, RunChain, toRunChain(read.value), "runs.chain");
  },
};
