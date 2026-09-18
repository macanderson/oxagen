// The runs port on the kernel (ARCHITECTURE.md §3.3): one cursor page of
// list_runs for the Fleet table, and the Run page's three reads (get_run,
// get_run_cost, get_run_transcript). Every one is a noBillingGate read, so no
// page load is refused for lack of GAUs, and each is mapped into its view
// model at the boundary.
//
// `get_run` is called with `waitMs: 0`: the page renders one frames page per
// request, and the long poll the contract offers belongs to the stream, not to
// a server render that would hold the response open for it (§3.5). It asks
// for `FRAME_PAGE` frames by name, because the mapper needs the size it asked
// for to tell a full page from the end of the recording.
import "server-only";
import { runCostGet } from "@oxagen/oxagen/contracts/run.cost";
import { runFrameBodyGet } from "@oxagen/oxagen/contracts/run.frame_body.get";
import { FRAME_LIMIT_DEFAULT, runGet } from "@oxagen/oxagen/contracts/run.get";
import { runList } from "@oxagen/oxagen/contracts/run.list";
import { runTranscriptGet } from "@oxagen/oxagen/contracts/run.transcript.get";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  RunCost,
  RunDetail,
  RunFrameBody,
  RunTranscript,
} from "@/data/contracts/run";
import { RunPage } from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
  toRunCost,
  toRunDetail,
  toRunFrameBody,
  toRunTranscript,
} from "./mappers/run";
import { toRunPage } from "./mappers/runs";

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
  async list(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: runList,
      input: q.cursor === null ? {} : { cursor: q.cursor },
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
  async transcript(ctx, runId, zoom) {
    const read = await kernelRead(ctx, {
      contract: runTranscriptGet,
      input: { runId, zoom },
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
};
