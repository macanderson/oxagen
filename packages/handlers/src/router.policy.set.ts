import type { CapabilityHandler } from "@oxagen/oxagen";
import { routerPolicySet } from "@oxagen/oxagen/contracts/router.policy.set";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { normalizeRoutingMode } from "./lib/routing-policy";
import { logger } from "./logger";

// set_routing_policy — partial update of the market-router policy at the org or
// workspace scope. Merges provided fields over the existing row (or OFF
// defaults) and upserts. High sensitivity: this changes model spend behavior, so
// the kernel gates it to Owner/Admin via the contract's defaultRoles.
export const routerPolicySetHandler: CapabilityHandler<
  typeof routerPolicySet
> = async (input, ctx) => {
  const scope = input.scope ?? "workspace";
  if (scope === "workspace" && !ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "set_routing_policy: rejected — workspace scope with no workspace context",
    );
    throw new Error(
      "set_routing_policy workspace scope requires a workspace context",
    );
  }
  // Org scope ⇒ workspace_id NULL (the org-level default row); workspace scope ⇒
  // this workspace's row.
  const targetWorkspaceId = scope === "org" ? null : ctx.workspaceId;

  const existing = await withTenantDb((tx) =>
    tx.query.routingPolicy.findFirst({
      where:
        targetWorkspaceId === null
          ? and(
              eq(schema.routingPolicy.orgId, ctx.orgId),
              isNull(schema.routingPolicy.workspaceId),
            )
          : eq(schema.routingPolicy.workspaceId, targetWorkspaceId),
    }),
  );

  const next = {
    mode: input.mode ?? normalizeRoutingMode(existing?.mode),
    successThreshold:
      input.successThreshold ?? existing?.successThreshold ?? 0.95,
    minSamples: input.minSamples ?? existing?.minSamples ?? 20,
    windowDays: input.windowDays ?? existing?.windowDays ?? 30,
    escalateOnRejection:
      input.escalateOnRejection ?? existing?.escalateOnRejection ?? true,
  };

  if (existing) {
    await withTenantDb((tx) =>
      tx
        .update(schema.routingPolicy)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(schema.routingPolicy.id, existing.id)),
    );
  } else {
    await withTenantDb((tx) =>
      tx.insert(schema.routingPolicy).values({
        orgId: ctx.orgId,
        workspaceId: targetWorkspaceId,
        ...next,
      }),
    );
  }

  logger.info(
    { orgId: ctx.orgId, scope, next, isInsert: !existing },
    "set_routing_policy: policy updated",
  );

  return { scope, ...next };
};
