import type { CapabilityHandler } from "@oxagen/oxagen";
import { agentMemoryPolicyWrite } from "@oxagen/oxagen/contracts/agent.memory_policy.write";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export const agentMemoryPolicyWriteHandler: CapabilityHandler<
  typeof agentMemoryPolicyWrite
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "agent.memory.policy.write: rejected — no workspace context",
    );
    throw new Error("agent.memory.policy.write requires a workspace context");
  }

  // UPSERT the policy row. We read first so we can return the merged result.
  const existing = await withTenantDb((tx) =>
    tx.query.workspaceMemoryPolicy.findFirst({
      where: eq(schema.workspaceMemoryPolicy.workspaceId, ctx.workspaceId),
    }),
  );

  const current = existing ?? {
    halfLifeLowDays: 30,
    halfLifeHighDays: 90,
    recallThreshold: 0.1,
    complianceThreshold: 70,
    defaultDecayFloor: 5,
  };

  const next = {
    halfLifeLowDays: input.halfLifeLowDays ?? current.halfLifeLowDays,
    halfLifeHighDays: input.halfLifeHighDays ?? current.halfLifeHighDays,
    recallThreshold: input.recallThreshold ?? current.recallThreshold ?? 0.1,
    complianceThreshold:
      input.complianceThreshold ?? current.complianceThreshold ?? 70,
    defaultDecayFloor:
      input.defaultDecayFloor ?? current.defaultDecayFloor ?? 5,
  };

  await withTenantDb(async (tx) => {
    if (existing) {
      await tx
        .update(schema.workspaceMemoryPolicy)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(schema.workspaceMemoryPolicy.workspaceId, ctx.workspaceId));
    } else {
      await tx.insert(schema.workspaceMemoryPolicy).values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        ...next,
      });
    }
  });

  logger.info(
    { workspaceId: ctx.workspaceId, next },
    "agent.memory.policy.write: policy updated",
  );

  return next;
};
