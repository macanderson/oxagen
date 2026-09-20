"use server";

import { runList } from "@oxagen/oxagen/contracts/run.list";
import { runGet } from "@oxagen/oxagen/contracts/run.get";
import { captureError } from "@oxagen/telemetry";
import type { RunDiff } from "@/data/contracts/run";
import { RunPage } from "@/data/contracts/runs";
import { moneyFromMicros } from "@/data/contracts/money";
import type { DataSource } from "@/data/ports";
import { type Read, readError } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** On-demand read through the kernel seam (ADR-089), scoped to the viewer. */
export async function searchBisectRuns(
  org: string,
  ws: string,
  runId: string,
  query: Omit<Parameters<DataSource["runs"]["list"]>[1], "excludeRunId" | "limit">,
): Promise<Read<RunPage>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: runList,
    input: { ...query, cursor: query.cursor ?? undefined, excludeRunId: runId, limit: 20 },
    page: "run",
  });
  if (!read.ok) return read;
  const parsed = RunPage.safeParse({
    nextCursor: read.value.nextCursor,
    runs: read.value.runs.map((run) => ({
      ...run,
      model: run.model === null ? null : { slug: run.model.id, provider: run.model.provider, tier: run.model.tier },
      cost: run.cost === null ? null : { ...moneyFromMicros(run.cost.micros, run.cost.currency), basis: run.cost.basis },
    })),
  });
  if (parsed.success) return { ok: true, value: parsed.data };
  captureError({ error: parsed.error, source: "app", orgId: ctx.orgId, context: "searchBisectRuns record_unmappable" });
  return readError("record_unmappable", 502);
}

/** Diff bytes stay out of list/search responses and are read only on request. */
export async function readRunDiff(org: string, ws: string, runId: string): Promise<Read<RunDiff | null>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, { contract: runGet, input: { runId, includeDiff: true, frameLimit: 1, waitMs: 0 }, page: "run" });
  return read.ok ? { ok: true, value: read.value.diff ?? null } : read;
}
