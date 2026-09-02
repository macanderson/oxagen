import type { CapabilityHandler } from "@oxagen/oxagen";
import { evalRunGet } from "@oxagen/oxagen/contracts/eval.run.get";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { selectEvalItemResults } from "@oxagen/telemetry";
import {
  evalTargetSchema,
  type EvalRunStatus,
} from "@oxagen/oxagen/contracts/eval-schema";

export const evalRunGetHandler: CapabilityHandler<typeof evalRunGet> = async (
  input,
  ctx,
) => {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.evalRuns.publicId,
        datasetPublicId: schema.evalDatasets.publicId,
        name: schema.evalRuns.name,
        target: schema.evalRuns.target,
        judgeModel: schema.evalRuns.judgeModel,
        passThreshold: schema.evalRuns.passThreshold,
        status: schema.evalRuns.status,
        itemCount: schema.evalRuns.itemCount,
        completedCount: schema.evalRuns.completedCount,
        failedCount: schema.evalRuns.failedCount,
        avgScore: schema.evalRuns.avgScore,
        scoreBreakdown: schema.evalRuns.scoreBreakdown,
        createdAt: schema.evalRuns.createdAt,
        workspaceId: schema.evalRuns.workspaceId,
      })
      .from(schema.evalRuns)
      .leftJoin(
        schema.evalDatasets,
        eq(schema.evalDatasets.id, schema.evalRuns.datasetId),
      )
      .where(eq(schema.evalRuns.publicId, input.runPublicId))
      .limit(1),
  );
  if (!row || row.workspaceId !== ctx.workspaceId) {
    throw new HTTPException(404, {
      message: `eval run ${input.runPublicId} not found`,
    });
  }

  // Per-item detail lives in the ClickHouse metering pipe (tenant-scoped read).
  const items = await selectEvalItemResults(input.runPublicId);

  return {
    run: {
      runId: row.publicId,
      datasetId: row.datasetPublicId ?? "",
      name: row.name,
      target: evalTargetSchema.parse(row.target),
      judgeModel: row.judgeModel,
      passThreshold: Number(row.passThreshold),
      status: row.status as EvalRunStatus,
      itemCount: row.itemCount,
      completedCount: row.completedCount,
      failedCount: row.failedCount,
      avgScore: row.avgScore != null ? Number(row.avgScore) : null,
      scoreBreakdown: (row.scoreBreakdown ?? {}) as Record<string, number>,
      createdAt: row.createdAt.toISOString(),
    },
    results: items.map((r) => ({
      itemId: r.item_id,
      targetKind: r.target_kind,
      model: r.model,
      judgeModel: r.judge_model,
      score: r.score,
      correctness: r.correctness,
      faithfulness: r.faithfulness,
      passed: r.passed === 1,
      latencyMs: r.latency_ms,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsdMicros: r.cost_usd_micros,
      status: r.status,
      errorClass: r.error_class,
      output: r.output,
      rationale: r.rationale,
    })),
  };
};
