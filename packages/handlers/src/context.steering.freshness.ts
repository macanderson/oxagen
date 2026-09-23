// audit-exempt: read-only — reports the steering version, the commit its
// newest record published at, the bound repository's production branch, and
// the workspace's two freshness gates. Mutates nothing. The kernel
// capability.invoke_* audit covers access.
//
// `get_steering_freshness` (ADR-061): the platform half of the steering
// freshness check. See the contract for why a developer's git is the primary
// signal and this is the check on it.
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  contextSteeringFreshness,
  steeringGatePolicyPatch,
  type ContextSteeringFreshnessOutput,
} from "@oxagen/oxagen/contracts/context.steering.freshness";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { readSteeringConnection } from "./context.steering.host";

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
  deps: Pick<SteeringDeps, "store"> & {
    /** The connection seam; injected so a test can answer without a database. */
    readConnection?: typeof readSteeringConnection;
  },
): CapabilityHandler<typeof contextSteeringFreshness> {
  const readConnection = deps.readConnection ?? readSteeringConnection;
  return async (_input, ctx): Promise<ContextSteeringFreshnessOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

    // Version and publication share one transaction (`versionAndPublication`)
    // so a promotion landing between two independent reads cannot pair the
    // new steering version with the old `headCommit`. The other two reads
    // run alongside it because this sits in front of a developer's prompt
    // and the latency is the whole budget.
    const [{ version: steeringVersion, publication }, binding, settings] =
      await Promise.all([
        deps.store.versionAndPublication(scope),
        // The same seam Context PRs resolve through, not a binding-only
        // query of its own. A workspace still on the legacy sources wizard
        // has no `repository_binding_heads` row, and the wizard's
        // `delivery_config` is what `context.steering.github.ts` falls back
        // to; reading bindings alone reported `repository: null`, the CLI
        // discarded the whole platform answer, and neither `autoSync` nor
        // `blockStaleRuns` could be enforced for that workspace. A legacy
        // connection states no default ref, so the CLI resolves the remote's
        // own, which is what it does whenever the platform names none. A
        // GitLab main project answers through the same reader (#3762).
        readConnection(scope).then((connection) =>
          connection === null
            ? null
            : {
                fullName:
                  connection.source === "binding"
                    ? connection.approvedFullName
                    : `${connection.owner}/${connection.repo}`,
                defaultRef:
                  connection.source === "binding"
                    ? connection.approvedDefaultRef
                    : null,
              },
        ),
        withTenantDb(async (tx) => {
          const rows = await tx
            .select({ settings: schema.workspaces.settings })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, scope.workspaceId))
            .limit(1);
          return rows[0]?.settings ?? null;
        }),
      ]);

    return {
      steeringVersion,
      headCommit: publication?.commitSha ?? null,
      headCommits: publication?.commitShas ?? [],
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
