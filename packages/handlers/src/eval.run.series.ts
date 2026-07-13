import type { CapabilityHandler } from "@oxagen/oxagen";
import { evalRunSeries } from "@oxagen/oxagen/contracts/eval.run.series";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { getModel } from "@oxagen/ai/catalog";

/** Map the validated bucket enum to a safe date_trunc literal — never raw text. */
function truncUnit(bucket: "day" | "week"): "day" | "week" {
  return bucket === "week" ? "week" : "day";
}

/** Coerce a possibly-string numeric (drizzle numeric / raw SQL) to number|null. */
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const evalRunSeriesHandler: CapabilityHandler<
  typeof evalRunSeries
> = async (input, _ctx) => {
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

    const unit = truncUnit(input.bucket);
    // date_trunc unit is a whitelisted literal ('day'|'week'), safe to inline.
    const bucketStart = sql<Date>`date_trunc(${sql.raw(`'${unit}'`)}, ${schema.evalRuns.createdAt})`;
    // Group model key: prefer the model, then the agent slug, else 'default'.
    const modelKey = sql<string>`COALESCE(${schema.evalRuns.target}->>'model', ${schema.evalRuns.target}->>'agentSlug', 'default')`;

    // Score aggregates count only completed runs (non-null avgScore).
    const filters = and(
      isNull(schema.evalRuns.deletedAt),
      isNotNull(schema.evalRuns.avgScore),
      datasetId ? eq(schema.evalRuns.datasetId, datasetId) : undefined,
      input.since
        ? gte(schema.evalRuns.createdAt, new Date(input.since))
        : undefined,
      input.until
        ? lte(schema.evalRuns.createdAt, new Date(input.until))
        : undefined,
    );

    // ── overall: one bucket per period, ascending ─────────────────────────────
    const overallRows = await tx
      .select({
        bucketStart,
        avgScore: sql<string | null>`avg(${schema.evalRuns.avgScore})`,
        runCount: sql<string | number>`count(*)`,
      })
      .from(schema.evalRuns)
      .where(filters)
      .groupBy(bucketStart)
      .orderBy(bucketStart);

    const overall = overallRows.map((r) => ({
      bucketStart: (r.bucketStart as Date).toISOString(),
      avgScore: num(r.avgScore),
      runCount: Number(r.runCount),
    }));

    // ── byModel: per-model aggregate + a per-bucket time series ────────────────
    const modelAggRows = await tx
      .select({
        model: modelKey,
        avgScore: sql<string | null>`avg(${schema.evalRuns.avgScore})`,
        passRate: sql<
          string | null
        >`avg(case when ${schema.evalRuns.avgScore} >= ${schema.evalRuns.passThreshold} then 1 else 0 end)`,
        runCount: sql<string | number>`count(*)`,
      })
      .from(schema.evalRuns)
      .where(filters)
      .groupBy(modelKey)
      .orderBy(modelKey);

    const modelPointRows = await tx
      .select({
        model: modelKey,
        bucketStart,
        avgScore: sql<string | null>`avg(${schema.evalRuns.avgScore})`,
      })
      .from(schema.evalRuns)
      .where(filters)
      .groupBy(modelKey, bucketStart)
      .orderBy(modelKey, bucketStart);

    const pointsByModel = new Map<
      string,
      { bucketStart: string; avgScore: number | null }[]
    >();
    for (const p of modelPointRows) {
      const key = p.model;
      const list = pointsByModel.get(key) ?? [];
      list.push({
        bucketStart: (p.bucketStart as Date).toISOString(),
        avgScore: num(p.avgScore),
      });
      pointsByModel.set(key, list);
    }

    const byModel = modelAggRows.map((r) => ({
      model: r.model,
      vendor: getModel(r.model)?.vendor ?? r.model.split("/")[0] ?? "other",
      avgScore: num(r.avgScore),
      passRate: num(r.passRate) ?? 0,
      runCount: Number(r.runCount),
      points: pointsByModel.get(r.model) ?? [],
    }));

    return { overall, byModel };
  });
};
