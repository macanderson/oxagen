import type { CapabilityHandler } from "@oxagen/oxagen";
import { evalRunStatus } from "@oxagen/oxagen/contracts/eval.run.status";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { EvalRunStatus } from "@oxagen/oxagen/contracts/eval-schema";

export const evalRunStatusHandler: CapabilityHandler<
  typeof evalRunStatus
> = async (input, ctx) => {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.evalRuns.publicId,
        status: schema.evalRuns.status,
        itemCount: schema.evalRuns.itemCount,
        completedCount: schema.evalRuns.completedCount,
        failedCount: schema.evalRuns.failedCount,
        avgScore: schema.evalRuns.avgScore,
        failureReason: schema.evalRuns.failureReason,
        workspaceId: schema.evalRuns.workspaceId,
      })
      .from(schema.evalRuns)
      .where(eq(schema.evalRuns.publicId, input.runPublicId))
      .limit(1),
  );
  if (!row || row.workspaceId !== ctx.workspaceId) {
    throw new HTTPException(404, {
      message: `eval run ${input.runPublicId} not found`,
    });
  }

  return {
    runId: row.publicId,
    status: row.status as EvalRunStatus,
    itemCount: row.itemCount,
    completedCount: row.completedCount,
    failedCount: row.failedCount,
    avgScore: row.avgScore != null ? Number(row.avgScore) : null,
    failureReason: row.failureReason,
  };
};
