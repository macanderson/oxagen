// audit-exempt: read-only — reports the steering version, the commit its
// newest record published at, the bound repository's production branch, and
// the workspace's two freshness gates. Mutates nothing. The kernel
// capability.invoke_* audit covers access.
//
// `get_steering_freshness` (ADR-061): the platform half of the steering
// freshness check. See the contract for why a developer's git is the primary
// signal and this is the check on it.
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  contextSteeringFreshness,
  steeringGatePolicyPatch,
  type ContextSteeringFreshnessOutput,
} from "@oxagen/oxagen/contracts/context.steering.freshness";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";

/**
 * Read the `steering` block out of `workspaces.settings`.
 *
 * The bag is `jsonb` written by `update_workspace_settings`, so the shape is
 * whatever was stored. It is parsed rather than cast, and a block that does
 * not parse reports as both gates off. The alternative would be to throw,
 * which would take out a hook in front of every developer's prompt across
 * the workspace over one bad value, and a governance control whose failure
 * mode is "nobody can work" gets uninstalled rather than fixed.
 *
 * Failing to off rather than on is deliberate in the same way: a gate that
 * turns itself on because a value was unreadable refuses prompts for a
 * reason nobody can act on.
 */
export function readGatePolicy(
  settings: unknown,
): ContextSteeringFreshnessOutput["policy"] {
  const block = (settings as { steering?: unknown } | null)?.steering;
  const parsed = steeringGatePolicyPatch.safeParse(block ?? {});
  return {
    autoSync: parsed.success ? (parsed.data.autoSync ?? false) : false,
    blockStaleRuns: parsed.success
      ? (parsed.data.blockStaleRuns ?? false)
      : false,
  };
}

export function createGetSteeringFreshnessHandler(
  deps: Pick<SteeringDeps, "store">,
): CapabilityHandler<typeof contextSteeringFreshness> {
  return async (_input, ctx): Promise<ContextSteeringFreshnessOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

    // Three independent reads. They run together because this sits in front
    // of a developer's prompt and the latency is the whole budget.
    const [steeringVersion, publication, binding, settings] = await Promise.all(
      [
        deps.store.ledgerLength(scope),
        deps.store.latestPublication(scope),
        withTenantDb(async (tx) => {
          const rows = await tx
            .select({
              fullName: schema.repositoryBindings.providerFullName,
              defaultRef: schema.repositoryBindings.configuredDefaultRef,
            })
            .from(schema.repositoryBindingHeads)
            .innerJoin(
              schema.repositoryBindings,
              eq(
                schema.repositoryBindings.id,
                schema.repositoryBindingHeads.currentBindingId,
              ),
            )
            .where(
              and(
                eq(schema.repositoryBindingHeads.orgId, scope.orgId),
                eq(
                  schema.repositoryBindingHeads.workspaceId,
                  scope.workspaceId,
                ),
              ),
            )
            .limit(1);
          return rows[0] ?? null;
        }),
        withTenantDb(async (tx) => {
          const rows = await tx
            .select({ settings: schema.workspaces.settings })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, scope.workspaceId))
            .limit(1);
          return rows[0]?.settings ?? null;
        }),
      ],
    );

    return {
      steeringVersion,
      headCommit: publication?.commitSha ?? null,
      publishedAt: publication?.publishedAt.toISOString() ?? null,
      repository: binding?.fullName ?? null,
      defaultBranch: binding?.defaultRef ?? null,
      policy: readGatePolicy(settings),
    };
  };
}

export const getSteeringFreshnessHandler = createGetSteeringFreshnessHandler(
  steeringDeps(),
);
