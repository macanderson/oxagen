import type { CapabilityHandler } from "@oxagen/oxagen";
import { evalRunStart } from "@oxagen/oxagen/contracts/eval.run.start";
import { schema, withTenantDb } from "@oxagen/database";
import { tierModelId } from "@oxagen/ai";
import { HTTPException } from "hono/http-exception";
import { eventClient } from "./event-client";
import { resolveDataset } from "./_eval";
import { logger } from "./logger";

export const evalRunStartHandler: CapabilityHandler<
  typeof evalRunStart
> = async (input, ctx) => {
  // Requested judge model, or the precise tier's resolved gateway id. Recorded
  // for reproducibility; the executor records the per-item resolved id too.
  const judgeModel = input.judgeModel ?? tierModelId("precise");

  const { runPublicId, runId, datasetInternalId, itemCount } =
    await withTenantDb(async (tx) => {
      const dataset = await resolveDataset(tx, input.datasetPublicId);
      if (dataset.itemCount === 0) {
        throw new HTTPException(422, {
          message: `eval dataset ${input.datasetPublicId} has no items to run`,
        });
      }
      const effectiveCount = input.maxItems
        ? Math.min(dataset.itemCount, input.maxItems)
        : dataset.itemCount;

      const [row] = await tx
        .insert(schema.evalRuns)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          datasetId: dataset.id,
          name: input.name ?? null,
          target: input.target,
          judgeModel,
          passThreshold: String(input.passThreshold),
          status: "pending",
          itemCount: effectiveCount,
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .returning({
          id: schema.evalRuns.id,
          publicId: schema.evalRuns.publicId,
        });
      if (!row) throw new Error("eval_runs insert failed");
      return {
        runPublicId: row.publicId,
        runId: row.id,
        datasetInternalId: dataset.id,
        itemCount: effectiveCount,
      };
    });

  // Enqueue the durable run. The executor (packages/inngest-functions) reads the
  // dataset items, runs each through the target + judge, and writes results.
  await eventClient.send({
    name: "eval/run.start",
    data: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      runId,
      runPublicId,
      datasetId: datasetInternalId,
      maxItems: input.maxItems ?? null,
    },
  });

  logger.info(
    { runId: runPublicId, itemCount, orgId: ctx.orgId },
    "eval.run.start enqueued",
  );

  return { runId: runPublicId, status: "pending", itemCount };
};
