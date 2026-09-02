import type { CapabilityHandler } from "@oxagen/oxagen";
import { agentMemoryPolicyRead } from "@oxagen/oxagen/contracts/agent.memory_policy.read";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// Defaults match the database column defaults.
const DEFAULT_POLICY = {
  halfLifeLowDays: 30,
  halfLifeHighDays: 90,
  recallThreshold: 0.1,
  complianceThreshold: 70,
  defaultDecayFloor: 5,
} as const;

export const agentMemoryPolicyReadHandler: CapabilityHandler<
  typeof agentMemoryPolicyRead
> = async (_input, ctx) => {
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "agent.memory.policy.read: rejected — no workspace context",
    );
    throw new Error("agent.memory.policy.read requires a workspace context");
  }

  const row = await withTenantDb((tx) =>
    tx.query.workspaceMemoryPolicy.findFirst({
      where: eq(schema.workspaceMemoryPolicy.workspaceId, ctx.workspaceId),
    }),
  );
  if (!row) {
    // No policy set — return defaults.
    logger.debug(
      { workspaceId: ctx.workspaceId },
      "agent.memory.policy.read: returning defaults",
    );
    return DEFAULT_POLICY;
  }

  logger.debug(
    { workspaceId: ctx.workspaceId },
    "agent.memory.policy.read: returning stored policy",
  );
  return {
    halfLifeLowDays: row.halfLifeLowDays,
    halfLifeHighDays: row.halfLifeHighDays,
    recallThreshold: row.recallThreshold ?? 0.1,
    complianceThreshold:
      row.complianceThreshold ?? DEFAULT_POLICY.complianceThreshold,
    defaultDecayFloor:
      row.defaultDecayFloor ?? DEFAULT_POLICY.defaultDecayFloor,
  };
};
