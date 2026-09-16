import type { CapabilityHandler } from "@oxagen/oxagen";
import { routerPolicySet } from "@oxagen/oxagen/contracts/router.policy.set";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/tenancy";
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
  // The nil uuid is the org-only workspace sentinel an organisation-level
  // surface carries when it has no workspace, and it is truthy, so `!ctx
  // .workspaceId` alone let it through. The row would then be written with the
  // sentinel as its workspace_id — WITH CHECK passes, because the row carries
  // the same value the workspace GUC holds — and the policy would apply to a
  // workspace that does not exist while looking like a saved workspace policy.
  // No call site reaches this today (every caller passes a real workspace id,
  // and routing_policy.workspace_id is elsewhere only ever a filter, see
  // ./lib/routing-policy.ts), so this is a guard against the next one rather
  // than a fix for a live path.
  if (
    scope === "workspace" &&
    (!ctx.workspaceId || ctx.workspaceId === ORG_ONLY_WORKSPACE_ID)
  ) {
    logger.warn(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
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
