// The runs port on the kernel (ARCHITECTURE.md §3.3): one cursor page of
// list_runs for the Fleet table, and the Run page's three reads (get_run,
// get_run_cost, get_run_transcript). Every one is a noBillingGate read, so no
// page load is refused for lack of GAUs, and each is mapped into its view
// model at the boundary.
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
import { runWorkGet } from "@oxagen/oxagen/contracts/run.work.get";
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
} from "@/data/contracts/run";
import { RunPage } from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
  toRunChain,
  toRunCost,
  toRunDetail,
  toRunFrameBody,
  toRunOutputs,
  toRunTranscript,
} from "./mappers/run";
import { toRunPage } from "./mappers/runs";

/**
 * Runs per Fleet read: the contract's ceiling. Fleet's search, facets, sort
 * and rows-per-page run over the rows one read returns, so the read takes as
 * many as the contract answers and the pager says when more are older.
 */
const RUN_PAGE = 100;

/** Frames per page of the Frames tab: the contract's own default, named so the mapper can see it. */
const FRAME_PAGE = FRAME_LIMIT_DEFAULT;

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
      input:
        q.cursor === null
          ? { limit: RUN_PAGE }
          : { limit: RUN_PAGE, cursor: q.cursor },
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
  async transcript(ctx, runId, zoom, q) {
    const read = await kernelRead(ctx, {
      contract: runTranscriptGet,
      input: {
        runId,
        zoom,
        kinds: q?.kinds ?? [],
        limit: TRANSCRIPT_ENTRY_DEFAULT,
        // Omitted rather than null: the contract refuses a cursor it did not
        // write, and `undefined` is what "read from the start" means there.
        ...(q?.after ? { after: q.after } : {}),
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
