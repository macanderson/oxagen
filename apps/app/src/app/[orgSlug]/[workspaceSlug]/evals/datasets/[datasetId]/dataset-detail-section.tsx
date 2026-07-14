/**
 * dataset-detail-section.tsx — Async server component that fetches everything
 * the dataset detail page needs (dataset + first page of items, the first page
 * of runs filtered to today, and the score-over-time series) in parallel, then
 * renders DatasetDetailClient.
 *
 * Rendered inside a <Suspense> boundary in page.tsx. Never throws from RSC for
 * the runs/series reads — a handler failure renders the client with what
 * loaded. A failed dataset get is fatal (the page is meaningless without it) →
 * notFound().
 *
 * Mirrors runs/[runId]/run-detail-section.tsx: build the ctx once, invoke with
 * NO surface option (every eval.* contract's `surfaces` is ["api","mcp","cli"]
 * — passing a surface opt throws surface_denied).
 */
import { notFound } from "next/navigation";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import type { EvalDatasetGetOutput } from "@oxagen/oxagen/contracts/eval.dataset.get";
import type { EvalRunListOutput } from "@oxagen/oxagen/contracts/eval.run.list";
import type { EvalRunSeriesOutput } from "@oxagen/oxagen/contracts/eval.run.series";
import { DatasetDetailClient } from "./dataset-detail-client";

interface DatasetDetailSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
  datasetPublicId: string;
}

/** UTC midnight of the current day, as an ISO string — the default runs filter. */
function startOfTodayUtcISO(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

export async function DatasetDetailSection({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
  datasetPublicId,
}: DatasetDetailSectionProps) {
  const ctx = {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  const since = startOfTodayUtcISO();

  const { dataset, runs, series } = await runInTenantScope(
    { orgId, workspaceId },
    async () => {
      // Dataset get is fatal on failure — the page needs it. Fetch it first so
      // a not-found short-circuits before doing the analytics reads.
      let datasetOut: EvalDatasetGetOutput | null = null;
      try {
        datasetOut = (await invoke(
          "get_dataset",
          { datasetPublicId, limit: 50 },
          ctx,
        )) as EvalDatasetGetOutput;
      } catch (e) {
        console.error("eval.dataset.get failed:", e);
      }

      // Runs (default: today) and the score series load in parallel and swallow
      // errors — the page still renders with whatever came back.
      const [runsOut, seriesOut] = await Promise.all([
        invoke(
          "list_eval_runs",
          {
            datasetPublicId,
            since,
            sortBy: "created",
            sortDir: "desc",
            limit: 25,
            offset: 0,
          },
          ctx,
        )
          .then((r) => r as EvalRunListOutput)
          .catch((e) => {
            console.error("eval.run.list failed:", e);
            return null;
          }),
        invoke("get_eval_run_series", { datasetPublicId, bucket: "day" }, ctx)
          .then((s) => s as EvalRunSeriesOutput)
          .catch((e) => {
            console.error("eval.run.series failed:", e);
            return null;
          }),
      ]);

      return { dataset: datasetOut, runs: runsOut, series: seriesOut };
    },
  );

  // A dataset that could not be loaded is a 404 — the page is meaningless
  // without it.
  if (!dataset) notFound();

  return (
    <DatasetDetailClient
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      datasetPublicId={datasetPublicId}
      dataset={dataset.dataset}
      initialItems={dataset.items}
      initialItemsCursor={dataset.nextCursor}
      initialRuns={runs?.runs ?? []}
      initialRunsTotal={runs?.total ?? 0}
      initialRunsAllTimeTotal={runs?.allTimeTotal ?? 0}
      initialSince={since}
      series={series}
    />
  );
}
