// steering_repo.adopt.ts: adopt_steering_merges (#5195).
//
// A person who merged Oxagen's own pull requests on GitHub, as the app once
// told them to, leaves the steering repo `diverged`, and Repair settings
// offers only the revert. This capability lets someone the governance mode
// lets merge adopt those merges instead. The work lives in
// ./steering-repo/adopt, which proves each merge, records it, and publishes.
// This file binds it to production and runs it in the repository's merge
// queue, so no merge lands while the adoption reads main.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { steeringRepoAdopt } from "@oxagen/oxagen/contracts/steering_repo.adopt";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq } from "drizzle-orm";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { assertContractRole } from "./lib/capability-role-guard";
import { steeringAppFromEnv } from "./lib/steering-app";
import { withToolProjection } from "./mcp-studio/publish-deps";
import { steeringInstallationRest } from "./steering_repo.provision";
import {
  type AdoptablePull,
  type AdoptDeps,
  type AdoptScope,
  adoptHostMerges,
} from "./steering-repo/adopt";
import { productionHealthStorage, refreshRepoHealth } from "./steering-repo/health";
import { loadHealthTarget } from "./steering-repo/health.hosts";
import { readSteeringHealth } from "./steering-repo/health.read";
import { inMergeQueue, readSteeringLayout } from "./steering-repo/merge-queue";
import { steeringSyncPublish } from "./steering-repo/publisher";

/** The newest proposal row this workspace holds for pull request `number` in `repository`. */
async function findAdoptablePull(
  scope: AdoptScope,
  repository: string,
  number: number,
): Promise<AdoptablePull | null> {
  const p = schema.steeringProposals;
  // tenancy: withTenantDb scopes the read to the caller's organization, and
  // the filter names the caller's workspace.
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: p.publicId,
        headSha: p.headSha,
        createdById: p.createdById,
        repository: p.repository,
      })
      .from(p)
      .where(
        and(
          eq(p.orgId, scope.orgId),
          eq(p.workspaceId, scope.workspaceId),
          eq(p.provider, "github"),
          eq(p.prNumber, number),
        ),
      )
      .orderBy(desc(p.createdAt))
      .limit(20),
  );
  // A repository renamed on the host keeps its rows under the bound name.
  const row = rows.find(
    (r) => r.repository?.toLowerCase() === repository.toLowerCase(),
  );
  return row
    ? { publicId: row.publicId, headSha: row.headSha, createdById: row.createdById }
    : null;
}

/** The dependencies adoptHostMerges runs with in production. */
export function productionAdoptDeps(steering: SteeringDeps): AdoptDeps {
  const host = steering.github;
  return {
    now: steering.now,
    locate: loadHealthTarget,
    loadRow: productionHealthStorage.loadRow,
    async history(located) {
      const { connection } = located;
      if (connection === null || connection.provider !== "github")
        throw new HandlerError({
          code: "conflict",
          reason: "steering_repo_disconnected",
          message:
            "The organization no longer has a GitHub steering connection. An organization admin must connect it again.",
        });
      const config = steeringAppFromEnv();
      if (config === null) return null;
      return {
        rest: await steeringInstallationRest(config, connection.installation_id),
        repo: {
          owner: located.owner,
          name: located.name,
          id: located.target.repository.id,
        },
        app: config.app,
      };
    },
    findPull: findAdoptablePull,
    mode: async (scope) =>
      (await readSteeringLayout(host, await host.resolveRepository(scope))).mode,
    roles: async (scope, userId) => ({
      orgRole: await steering.roles.orgRole(scope.orgId, userId),
      workspaceRole: await steering.roles.workspaceRole(
        scope.orgId,
        scope.workspaceId,
        userId,
      ),
    }),
    refresh: refreshRepoHealth,
    // The repository sync's own publish port: it publishes main through the
    // workspace's version store and records the deployment.
    publish: async (scope) =>
      (
        await steeringSyncPublish({
          host,
          extend: withToolProjection,
          readHealth: readSteeringHealth,
          recordDeployments: true,
        })(scope)
      )?.version ?? null,
    emit: steering.emit,
  };
}

export function createAdoptSteeringMergesHandler(
  steering: SteeringDeps,
  deps: AdoptDeps = productionAdoptDeps(steering),
): CapabilityHandler<typeof steeringRepoAdopt> {
  return async (_input, ctx) => {
    // The kernel's IAM check allows every capability for a non-enterprise
    // org, so the handler asks for the contract's roles itself (INV-29). The
    // governance mode narrows them further inside the adoption.
    await assertContractRole(steeringRepoAdopt, ctx);
    if (!ctx.workspaceId)
      throw new Error("[adopt_steering_merges] workspaceId is required (scoped capability)");
    const scope: AdoptScope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const repo = await steering.github.resolveRepository(scope);
    return inMergeQueue(repo, () =>
      adoptHostMerges(
        scope,
        { actorUserId: ctx.userId ?? null, requestId: ctx.requestId ?? null },
        deps,
      ),
    );
  };
}

export const adoptSteeringMergesHandler: CapabilityHandler<typeof steeringRepoAdopt> =
  async (input, ctx) => createAdoptSteeringMergesHandler(steeringDeps())(input, ctx);
