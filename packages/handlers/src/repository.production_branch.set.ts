// repository.production_branch.set.ts — `set_production_branch` (Mission
// Control spec §10.1, §11.4).
//
// Flow:
//   1. The bound repository by its binding id (`not_found:
//      repository_not_linked`), then the role gate for its role: the main
//      repository's branch is where steering lives, so an org Owner or Admin;
//      a linked one also admits the workspace Owner (INV-29).
//   2. The same branch the binding records: nothing is written and the
//      answer says `changed: false`. Confirming is not an event.
//   3. GitHub, through the workspace's installation: the repository must
//      still be the one the binding pins (same immutable id) and the branch
//      must exist (`not_found: branch_not_found`).
//   4. One transaction under the workspace's repository lock: the head is
//      re-read (a concurrent write may have moved it), a successor binding
//      version carrying the branch is written, and the head moves onto it.
//      The old version stays, because runs admitted against it cite it.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  repositoryProductionBranchSet,
  type RepositoryProductionBranchSetOutput,
} from "@oxagen/oxagen/contracts/repository.production_branch.set";
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import type { GitHubRepoInfo } from "@oxagen/github";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  readBoundRepository,
  repositoryNotLinked,
  requireBoundRepoInfo,
  requireWorkspaceGithub,
  selectBoundRepository,
  workspaceGithub,
  type BoundRepository,
  type WorkspaceGithub,
} from "./repository.bound";
import { GITHUB_PROVIDER } from "./repository.github-connection";
import { workspaceRepositoriesLock } from "./repository.main.bind";

type Scope = { orgId: string; workspaceId: string };

export interface ProductionBranchWrite {
  scope: Scope;
  bindingId: string;
  repo: GitHubRepoInfo;
  branch: string;
  userId: string;
  now: Date;
}

export interface ProductionBranchWritten {
  bindingId: string;
  previousBranch: string;
  changed: boolean;
}

/**
 * Write a successor binding version carrying `branch` and move the head onto
 * it, on `tx`, under the workspace lock. The head is re-read inside the lock:
 * a head that no longer carries `bindingId` was moved by a concurrent write,
 * and this refuses rather than superseding a version it never read.
 */
export async function writeProductionBranch(
  tx: Tx,
  args: ProductionBranchWrite,
): Promise<ProductionBranchWritten> {
  const { scope, repo, branch, userId, now } = args;
  await tx.execute(workspaceRepositoriesLock(scope.workspaceId));
  const bound = await selectBoundRepository(tx, scope, args.bindingId);
  if (!bound) throw repositoryNotLinked(args.bindingId);
  if (bound.productionBranch === branch) {
    return {
      bindingId: bound.bindingId,
      previousBranch: branch,
      changed: false,
    };
  }

  // The newest version this connection holds for the repository, which is
  // not always the one the head points at: an unlink and a re-link leave
  // versions behind, and `repository_bindings_repository_version_uq` is on
  // (connection, repository, version).
  const [latest] = await tx
    .select({ version: schema.repositoryBindings.version })
    .from(schema.repositoryBindings)
    .where(
      and(
        eq(schema.repositoryBindings.orgId, scope.orgId),
        eq(schema.repositoryBindings.workspaceId, scope.workspaceId),
        eq(schema.repositoryBindings.connectionId, bound.connectionId),
        eq(
          schema.repositoryBindings.providerRepositoryId,
          bound.providerRepositoryId,
        ),
      ),
    )
    .orderBy(desc(schema.repositoryBindings.version))
    .limit(1);

  const [inserted] = await tx
    .insert(schema.repositoryBindings)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      connectionId: bound.connectionId,
      provider: GITHUB_PROVIDER,
      providerRepositoryId: bound.providerRepositoryId,
      providerOwner: repo.owner,
      providerName: repo.name,
      providerFullName: repo.fullName,
      configuredDefaultRef: branch,
      observedAt: now,
      version: (latest?.version ?? bound.version) + 1,
      supersedesBindingId: bound.bindingRowId,
      createdAt: now,
      createdById: userId,
    })
    .returning({
      id: schema.repositoryBindings.id,
      publicId: schema.repositoryBindings.publicId,
    });
  if (!inserted) throw new Error("repository_bindings insert returned no row");

  await tx
    .update(schema.repositoryBindingHeads)
    .set({ currentBindingId: inserted.id, updatedAt: now })
    .where(eq(schema.repositoryBindingHeads.id, bound.headId));

  return {
    bindingId: inserted.publicId,
    previousBranch: bound.productionBranch,
    changed: true,
  };
}

export interface ProductionBranchDeps {
  github: WorkspaceGithub;
  readBound: typeof readBoundRepository;
  write: (args: ProductionBranchWrite) => Promise<ProductionBranchWritten>;
  now: () => Date;
}

/** The roles that may move a repository's production branch, by its role. */
export function productionBranchRoles(role: BoundRepository["role"]) {
  return role === "main"
    ? { org: ["Owner", "Admin"] }
    : { org: ["Owner", "Admin"], workspace: ["Owner"] };
}

export function createProductionBranchSetHandler(
  deps: ProductionBranchDeps,
): CapabilityHandler<typeof repositoryProductionBranchSet> {
  return async (input, ctx): Promise<RepositoryProductionBranchSetOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const bound = await deps.readBound(scope, input.bindingId);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      productionBranchRoles(bound.role),
    );
    const now = deps.now();

    if (bound.productionBranch === input.branch) {
      return {
        bindingId: bound.bindingId,
        fullName: bound.fullName,
        productionBranch: input.branch,
        previousBranch: input.branch,
        changed: false,
        setAt: now.toISOString(),
      };
    }

    const gh = await requireWorkspaceGithub(deps.github, scope);
    // A repository deleted and re-created under the same name has a new id.
    // Writing its branch onto this binding would pin the old repository's
    // history to a different repository.
    const repo: GitHubRepoInfo = await requireBoundRepoInfo(gh, bound);

    const branch = await gh.getBranch({
      owner: repo.owner,
      repo: repo.name,
      branch: input.branch,
    });
    if (!branch) {
      throw new HandlerError({
        code: "not_found",
        reason: "branch_not_found",
        message: `${repo.fullName} has no branch named ${input.branch}`,
      });
    }

    const written = await deps.write({
      scope,
      bindingId: bound.bindingId,
      repo,
      branch: input.branch,
      userId: actingUserId as string,
      now,
    });

    logger.info(
      {
        ...scope,
        repository: repo.fullName,
        from: written.previousBranch,
        to: input.branch,
        changed: written.changed,
      },
      "repository.production_branch.set: production branch set",
    );

    return {
      bindingId: written.bindingId,
      fullName: repo.fullName,
      productionBranch: input.branch,
      previousBranch: written.previousBranch,
      changed: written.changed,
      setAt: now.toISOString(),
    };
  };
}

export const repositoryProductionBranchSetHandler =
  createProductionBranchSetHandler({
    github: workspaceGithub,
    readBound: readBoundRepository,
    write: (args) => withTenantDb((tx) => writeProductionBranch(tx, args)),
    now: () => new Date(),
  });
