import type { CapabilityHandler } from "@oxagen/oxagen";
import { evalRunList } from "@oxagen/oxagen/contracts/eval.run.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, asc, count, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { selectEvalRunCostRollup } from "@oxagen/telemetry";
import { logger } from "./logger";

// SQL fragment selecting the target's model string out of the target jsonb.
const targetModel = sql<string>`${schema.evalRuns.target}->>'model'`;

export const evalRunListHandler: CapabilityHandler<typeof evalRunList> = async (
  input,
  _ctx,
) => {
  return withTenantDb(async (tx) => {
    // Resolve an optional dataset filter to its internal uuid (404 if missing).
    let datasetId: string | null = null;
    if (input.datasetPublicId) {
      const [dataset] = await tx
        .select({ id: schema.evalDatasets.id })
        .from(schema.evalDatasets)
        .where(eq(schema.evalDatasets.publicId, input.datasetPublicId))
        .limit(1);
      if (!dataset) {
        throw new HTTPException(404, {
          message: `eval dataset ${input.datasetPublicId} not found`,
        });
      }
      datasetId = dataset.id;
    }

    // Filter set applied to the page and the `total` count.
    const filters = and(
      isNull(schema.evalRuns.deletedAt),
      datasetId ? eq(schema.evalRuns.datasetId, datasetId) : undefined,
      input.since
        ? gte(schema.evalRuns.createdAt, new Date(input.since))
        : undefined,
      input.until
        ? lte(schema.evalRuns.createdAt, new Date(input.until))
        : undefined,
      input.status ? eq(schema.evalRuns.status, input.status) : undefined,
      input.model ? eq(targetModel, input.model) : undefined,
    );

    // ORDER BY: map the sort key to a column, apply the direction. Score desc
    // pushes NULL (unfinished) runs to the bottom so the best completed runs lead.
    const orderCol =
      input.sortBy === "score"
        ? schema.evalRuns.avgScore
        : input.sortBy === "model"
          ? targetModel
          : input.sortBy === "status"
            ? schema.evalRuns.status
            : schema.evalRuns.createdAt;
    const orderExpr =
      input.sortDir === "asc"
        ? asc(orderCol)
        : input.sortBy === "score"
          ? sql`${orderCol} desc nulls last`
          : desc(orderCol);

    const pageRows = await tx
      .select({
        runId: schema.evalRuns.publicId,
        datasetName: schema.evalDatasets.name,
        datasetSlug: schema.evalDatasets.slug,
        datasetPublicId: schema.evalDatasets.publicId,
        name: schema.evalRuns.name,
        target: schema.evalRuns.target,
        judgeModel: schema.evalRuns.judgeModel,
        status: schema.evalRuns.status,
        itemCount: schema.evalRuns.itemCount,
        completedCount: schema.evalRuns.completedCount,
        failedCount: schema.evalRuns.failedCount,
        avgScore: schema.evalRuns.avgScore,
        passThreshold: schema.evalRuns.passThreshold,
        createdAt: schema.evalRuns.createdAt,
        completedAt: schema.evalRuns.completedAt,
      })
      .from(schema.evalRuns)
      .innerJoin(
        schema.evalDatasets,
        eq(schema.evalRuns.datasetId, schema.evalDatasets.id),
      )
      .where(filters)
      .orderBy(orderExpr)
      .limit(input.limit)
      .offset(input.offset);

    // `total` counts every run matching the same filters (ignores paging).
    const [totalRow] = await tx
      .select({ n: count() })
      .from(schema.evalRuns)
      .where(filters);
    const total = totalRow?.n ?? 0;

    // `allTimeTotal` ignores since/until/status/model — only soft-delete and an
    // optional dataset scope — so the UI can show "N of M (all-time K)".
    const [allTimeRow] = await tx
      .select({ n: count() })
      .from(schema.evalRuns)
      .where(
        and(
          isNull(schema.evalRuns.deletedAt),
          datasetId ? eq(schema.evalRuns.datasetId, datasetId) : undefined,
        ),
      );
    const allTimeTotal = allTimeRow?.n ?? 0;

    // Roll up per-run cost/tokens from ClickHouse. The list must still return if
    // the metering pipe is unavailable, so any failure defaults every run to zero.
    const runIds = pageRows.map((r) => r.runId);
    let costByRun = new Map<
      string,
      { costUsdMicros: number; inputTokens: number; outputTokens: number }
    >();
    try {
      costByRun = await selectEvalRunCostRollup(runIds);
    } catch (err) {
      logger.warn(
        { err, runCount: runIds.length },
        "eval.run.list: ClickHouse cost rollup failed; defaulting to zero cost",
      );
    }

    return {
      runs: pageRows.map((r) => {
        const target = (r.target ?? {}) as {
          kind?: "model" | "agent";
          model?: string;
          agentSlug?: string;
        };
        const cost = costByRun.get(r.runId);
        return {
          runId: r.runId,
          datasetId: r.datasetPublicId,
          datasetName: r.datasetName,
          datasetSlug: r.datasetSlug,
          name: r.name,
          target: {
            kind:
              target.kind === "agent" ? ("agent" as const) : ("model" as const),
            model: target.model ?? null,
            agentSlug: target.agentSlug ?? null,
          },
          judgeModel: r.judgeModel,
          status: r.status,
          itemCount: r.itemCount,
          completedCount: r.completedCount,
          failedCount: r.failedCount,
          avgScore: r.avgScore != null ? Number(r.avgScore) : null,
          passThreshold: Number(r.passThreshold),
          costUsdMicros: cost?.costUsdMicros ?? 0,
          inputTokens: cost?.inputTokens ?? 0,
          outputTokens: cost?.outputTokens ?? 0,
          createdAt: r.createdAt.toISOString(),
          completedAt: r.completedAt ? r.completedAt.toISOString() : null,
        };
      }),
      total,
      allTimeTotal,
    };
  });
};
