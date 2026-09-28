// repository.link.reconcile.ts: the heads follow workspace.toml (ADR-212).
//
// workspace.toml on the steering repository lists the workspace's linked code
// repositories. `link_repository` and `unlink_repository` open steering PRs
// that edit the list, and write no head. This module moves the heads once such
// a PR merges. The steering sync calls it once per synced head, with the list
// the prior synced head held and the list the new head holds:
//
//   1. Removals. A linked head whose entry the prior list held and the new
//      list drops is deleted, under the workspace's repository lock. A linked
//      head the prior list never named stays: it predates the steering
//      record, and `unlink_repository` deletes it directly. When nobody can
//      tell what the prior list held, nothing is removed.
//   2. Additions. An entry with no head gets one, through the checks
//      `link_repository` ran before it opened the PR
//      (`repository.link.write.ts`). The sync is the writer, so the binding
//      names no Oxagen user.
//
// A repository the sync cannot link becomes one warning finding with code
// `repository_link`. The sync still succeeds, because the rules the same head
// carries still publish. A head a concurrent write already created is not a
// problem. Any other error stops the sync, and the next run tries again.
//
// Removals run before additions, so an entry renamed in one PR loses its old
// head before the new one is written. Running this again with the same lists
// changes nothing: every entry has its head, and no entry went away.
import { isHandlerError } from "@oxagen/oxagen";
import { WORKSPACE_TOML_PATH } from "@oxagen/oxagen/steering-repo/paths";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { and, eq, inArray } from "drizzle-orm";
import type { SyncFinding } from "./context.steering.sync.plan";
import { logger } from "./logger";
import {
  githubMainRepositoryDeps,
  type MainRepositoryDeps,
  workspaceRepositoriesLock,
} from "./repository.binding-write";
import { GITHUB_PROVIDER } from "./repository.github-connection";
import { linkRepositoryHead } from "./repository.link.write";
import {
  GITHUB_HOST,
  githubRepoRef,
  splitRepoRef,
} from "./repository.workspace-toml";

type Scope = { orgId: string; workspaceId: string };

/** The two lists one synced head compares. */
export interface LinkChange {
  /**
   * The repositories the prior synced head's workspace.toml listed. Null when
   * nobody can tell: no head was synced before, or its file did not read.
   */
  prior: string[] | null;
  /** The repositories the new head's workspace.toml lists. */
  current: string[];
  now: Date;
}

/** What one reconcile did. */
export interface LinkReconciled {
  linked: string[];
  unlinked: string[];
  findings: SyncFinding[];
}

/** The link half of the steering sync, as `SyncDeps` carries it. */
export type ReconcileLinks = (
  scope: Scope,
  change: LinkChange,
) => Promise<LinkReconciled>;

interface HeadRow {
  id: string;
  role: string;
  ref: string | null;
  fullName: string;
}

/**
 * Every head in the workspace, with the ref workspace.toml would list it by.
 * A head on another host has no ref, because `link_repository` writes GitHub
 * repositories only.
 */
async function readHeads(tx: Tx, scope: Scope): Promise<HeadRow[]> {
  const rows = await tx
    .select({
      id: schema.repositoryBindingHeads.id,
      role: schema.repositoryBindingHeads.role,
      provider: schema.repositoryBindingHeads.provider,
      owner: schema.repositoryBindings.providerOwner,
      name: schema.repositoryBindings.providerName,
      fullName: schema.repositoryBindings.providerFullName,
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
        eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    ref: r.provider === GITHUB_PROVIDER ? refOf(r.owner, r.name) : null,
    fullName: r.fullName,
  }));
}

/** The ref of a GitHub repository, or null for a name no ref can spell. */
function refOf(owner: string, name: string): string | null {
  try {
    return githubRepoRef(owner, name);
  } catch {
    return null;
  }
}

function warning(message: string): SyncFinding {
  return {
    level: "warning",
    path: WORKSPACE_TOML_PATH,
    lineageId: null,
    code: "repository_link",
    message,
  };
}

/** Step 1: delete the linked heads whose entries the new list dropped. */
async function removeDropped(
  scope: Scope,
  change: LinkChange,
): Promise<string[]> {
  if (change.prior === null) return [];
  const current = new Set(change.current);
  const dropped = new Set(change.prior.filter((ref) => !current.has(ref)));
  if (dropped.size === 0) return [];
  return withTenantDb(async (tx) => {
    // The lock every repository writer takes, and the heads read again under
    // it: an unlink or a second sync may have moved them since.
    await tx.execute(workspaceRepositoriesLock(scope.workspaceId));
    const gone = (await readHeads(tx, scope)).filter(
      (h) =>
        !schema.isSteeringHeadRole(h.role) &&
        h.ref !== null &&
        dropped.has(h.ref),
    );
    if (gone.length > 0)
      await tx.delete(schema.repositoryBindingHeads).where(
        inArray(
          schema.repositoryBindingHeads.id,
          gone.map((h) => h.id),
        ),
      );
    return gone.map((h) => h.fullName);
  });
}

/** Step 2: write a head for each listed repository that has none. */
async function addListed(
  scope: Scope,
  change: LinkChange,
  deps: Pick<MainRepositoryDeps, "repository">,
): Promise<{ linked: string[]; findings: SyncFinding[] }> {
  const held = new Map<string, HeadRow>();
  for (const head of await withTenantDb((tx) => readHeads(tx, scope)))
    if (head.ref !== null) held.set(head.ref, head);

  const linked: string[] = [];
  const findings: SyncFinding[] = [];
  for (const ref of change.current) {
    const head = held.get(ref);
    if (head && schema.isSteeringHeadRole(head.role)) {
      findings.push(
        warning(
          `${WORKSPACE_TOML_PATH} lists ${ref}, the workspace's steering repository. The steering repository is not linked to its own workspace, so the entry does nothing. Remove it.`,
        ),
      );
      continue;
    }
    if (head) continue;
    const { host, owner, name } = splitRepoRef(ref);
    if (host !== GITHUB_HOST) {
      findings.push(
        warning(
          `${WORKSPACE_TOML_PATH} lists ${ref}. Oxagen links GitHub repositories only, so it is not linked.`,
        ),
      );
      continue;
    }
    try {
      const written = await linkRepositoryHead(
        scope,
        { owner, name },
        { userId: null, now: change.now },
        deps,
      );
      linked.push(written.fullName);
    } catch (err) {
      if (!isHandlerError(err)) throw err;
      // A concurrent sync or a legacy link wrote it first. The entry has
      // its head, which is all this step wants.
      if (err.reason === "repository_already_linked") continue;
      findings.push(
        warning(
          `${WORKSPACE_TOML_PATH} lists ${ref}, and Oxagen could not link it (${err.reason}). ${err.message}`,
        ),
      );
    }
  }
  return { linked, findings };
}

/** The reconcile with its GitHub reader injected, for tests. */
export function createLinkReconciler(
  deps: Pick<MainRepositoryDeps, "repository">,
): ReconcileLinks {
  return async (scope, change) => {
    const unlinked = await removeDropped(scope, change);
    const { linked, findings } = await addListed(scope, change, deps);
    if (linked.length > 0 || unlinked.length > 0 || findings.length > 0)
      logger.info(
        {
          ...scope,
          linked,
          unlinked,
          findings: findings.length,
        },
        "repository.link.reconcile: the linked repositories follow workspace.toml",
      );
    return { linked, unlinked, findings };
  };
}

export const reconcileWorkspaceLinks = createLinkReconciler(
  githubMainRepositoryDeps,
);
