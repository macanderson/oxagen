// repository.binding-write.ts: the one writer of a NEW binding head, shared
// by the steering provisioner (the steering head, steering_repo.provision.ts)
// and the steering sync (a linked head, once a steering PR that lists the
// repository merges; see repository.link.write.ts). It also holds what every
// writer of a workspace's heads shares: the workspace lock, the reading of a
// head write the store refused, and the GitHub repository reader.
//
// `bind_main_repository` was the last writer that repaired or re-approved an
// EXISTING head in place. #4616 removed it (ADR-212), so a head is now only
// ever added here, and `set_production_branch` moves an existing one.
//
// A binding is immutable and versioned (`ingestion.repository_bindings`), and
// `repository_bindings_repository_version_uq` is on (connection, repository,
// version). A repository this connection bound before — linked, unlinked, and
// now linked again — therefore already HAS a version 1, and writing another
// would violate that index. So the latest version for the pair is read first:
// reused when nothing it records has moved, superseded by version + 1 when
// something has, and only when there is none is a version 1 written.
import { schema, type Tx } from "@oxagen/database";
import { createGitHubClient, getInstallationToken } from "@oxagen/github";
import type { GitHubRepoInfo } from "@oxagen/github";
import { and, desc, eq, sql } from "drizzle-orm";
import { isInstallationTokenRefused } from "./repository.bound";
import { GITHUB_PROVIDER } from "./repository.github-connection";

/**
 * The transaction-scoped advisory lock every writer of a workspace's binding
 * heads takes, so each reads the heads the previous one committed. The
 * writers are `link_repository`, the steering sync, `unlink_repository`,
 * `set_production_branch`, and the steering provisioner's bind step. The key
 * keeps the spelling of `bind_main_repository`, its first writer (removed in
 * #4616), so a deploy that mixes old and new processes still serialises on
 * one lock.
 */
export function workspaceRepositoriesLock(workspaceId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bind_main_repository:${workspaceId}`}::text, 0))`;
}

/**
 * A head's role (`repository_binding_heads_role_check`). `steering` is the
 * workspace's steering record source, of which it has one; `linked` is a code
 * repository, of which it may have many. 20260927185600 moved every former
 * `main` head to `steering` (ADR-212).
 */
export type RepositoryHeadRole = "linked" | "steering";

/** The hosts a binding can name (`repository_bindings_provider_check`). */
export type RepositoryProvider = "github" | "gitlab";

/**
 * The repository facts a binding records, whichever host reported them. A
 * GitHub `GitHubRepoInfo` satisfies it; on GitLab `owner` is the full
 * namespace path and `id` the numeric project id.
 */
export interface BindableRepository {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

/**
 * What a 23505 from the heads table means, by constraint name. One
 * cross-workspace rule is left (ADR-293): a repository steers at most one
 * workspace, held by the partial unique index on steering heads. Only a
 * steering head write can break it. A linked head is outside the index's
 * predicate, so no other workspace's heads can refuse a link.
 *
 * 20261003190000 dropped the trigger `repository_binding_heads_exclusive_main`
 * and the two names it raised for a linked head beside another workspace's
 * steering head. Neither name can reach a writer now.
 */
const HEAD_CONFLICT_BY_CONSTRAINT: Readonly<
  Record<string, RepositoryHeadConflict>
> = {
  // A steering head written for a repository another workspace steers by.
  repository_binding_heads_main_repository_uq: "main_elsewhere",
};

/**
 * Which cross-workspace rule a head write broke. `main_elsewhere`: the
 * repository already steers another workspace, so it cannot steer this one
 * too. The name keeps the store's `main` spelling.
 */
export type RepositoryHeadConflict = "main_elsewhere";

/**
 * The cross-workspace rule a failed steering head write broke, or null when
 * the error is something else. No writer in service reads it today. The
 * steering provisioner binds a repository Oxagen created for the workspace
 * and passes a refused bind through unmapped. The Postgres tests read it to
 * name the refusal.
 *
 * Matched on the constraint NAME rather than on 23505 alone: this insert can
 * also violate `repository_binding_heads_repository_uq`, which means something
 * else entirely, and reporting that as "claimed by another workspace" would
 * send the operator to look for a workspace that does not exist. Postgres
 * carries the name on the error; the driver nests it under `cause`.
 */
export function repositoryHeadConflict(
  err: unknown,
): RepositoryHeadConflict | null {
  for (let e: unknown = err, hops = 0; e != null && hops < 5; hops++) {
    const row = e as {
      code?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (row.code === "23505" && typeof row.constraint_name === "string") {
      return HEAD_CONFLICT_BY_CONSTRAINT[row.constraint_name] ?? null;
    }
    e = row.cause;
  }
  return null;
}

/** Reads a repository through a GitHub App installation. Tests pass a fake. */
export interface MainRepositoryDeps {
  /** The repository as the installation sees it, or null when it cannot. */
  repository(
    installationId: string,
    owner: string,
    name: string,
  ): Promise<GitHubRepoInfo | null>;
}

export const githubMainRepositoryDeps: MainRepositoryDeps = {
  async repository(installationId, owner, name) {
    const appId = process.env["GITHUB_APP_ID"];
    const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"];
    if (!appId || !privateKey) {
      throw new Error(
        "GitHub App is not configured: GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY unset",
      );
    }
    // The token reaches the one repository the link names, with the
    // metadata read `getRepoInfo` needs and nothing more (#4753). A
    // repository the installation does not include is refused at the mint,
    // which is the same answer as the 404 below.
    let token: string;
    try {
      ({ token } = await getInstallationToken({
        appId,
        privateKey,
        installationId,
        repositories: [name],
        permissions: { metadata: "read" },
      }));
    } catch (err) {
      if (isInstallationTokenRefused(err)) return null;
      throw err;
    }
    try {
      return await createGitHubClient({ token }).getRepoInfo({
        owner,
        repo: name,
      });
    } catch (err) {
      // The client throws on every non-2xx; an installation that cannot see
      // the repository answers 404, which is the refusal a writer names.
      if (
        err instanceof Error &&
        err.message.startsWith("GitHub API error 404")
      )
        return null;
      throw err;
    }
  },
};

export interface NewRepositoryHead {
  scope: { orgId: string; workspaceId: string };
  /** The `source_connections` row the head and binding hang off. */
  connectionId: string;
  repo: BindableRepository;
  role: RepositoryHeadRole;
  /**
   * The host. Defaults to GitHub, the only host `link_repository` binds
   * today; the steering provisioner passes GitLab for a GitLab group. `provider_repository_id` is unique only
   * within one host, so the retained-version lookup filters on it too.
   */
  provider?: RepositoryProvider;
  /**
   * The person who asked for the head, or null when the steering sync writes
   * it after a steering PR merged (ADR-212). The merge is the host's fact,
   * and the merging account need not be an Oxagen user.
   */
  userId: string | null;
  now: Date;
}

export interface WrittenRepositoryHead {
  /** `rpb_…` of the binding version the new head points at. */
  bindingPublicId: string;
}

/**
 * Write a binding head for `repo` on `tx`, reusing the latest binding version
 * when nothing it records has moved, and superseding it otherwise. The caller
 * has already decided the head may exist (role and duplicates) and holds the
 * workspace lock.
 *
 * The latest version is the workspace's for this repository through ANY
 * connection (#3340 finding 7). A binding version is the evidence an admitted
 * run cites, and the versions of one repository in one workspace form one
 * lineage. Looked up on the connection alone, a relink through the
 * connection that replaced a retired one found nothing and wrote a second
 * version 1 with no predecessor, splitting the chain. A version another
 * connection holds is superseded, never reused, so the head and its binding
 * name the same connection.
 */
export async function writeRepositoryHead(
  tx: Tx,
  args: NewRepositoryHead,
): Promise<WrittenRepositoryHead> {
  const { scope, connectionId, repo, role, userId, now } = args;
  const provider = args.provider ?? GITHUB_PROVIDER;

  const [latest] = await tx
    .select({
      id: schema.repositoryBindings.id,
      publicId: schema.repositoryBindings.publicId,
      connectionId: schema.repositoryBindings.connectionId,
      version: schema.repositoryBindings.version,
      providerOwner: schema.repositoryBindings.providerOwner,
      providerName: schema.repositoryBindings.providerName,
      providerFullName: schema.repositoryBindings.providerFullName,
      configuredDefaultRef: schema.repositoryBindings.configuredDefaultRef,
    })
    .from(schema.repositoryBindings)
    .where(
      and(
        eq(schema.repositoryBindings.orgId, scope.orgId),
        eq(schema.repositoryBindings.workspaceId, scope.workspaceId),
        eq(schema.repositoryBindings.provider, provider),
        eq(schema.repositoryBindings.providerRepositoryId, repo.id),
      ),
    )
    .orderBy(
      desc(schema.repositoryBindings.version),
      desc(schema.repositoryBindings.createdAt),
    )
    .limit(1);

  let binding: { id: string; publicId: string };
  const unchanged =
    latest !== undefined &&
    latest.connectionId === connectionId &&
    latest.providerOwner === repo.owner &&
    latest.providerName === repo.name &&
    latest.providerFullName === repo.fullName &&
    latest.configuredDefaultRef === repo.defaultBranch;
  if (latest !== undefined && unchanged) {
    binding = { id: latest.id, publicId: latest.publicId };
  } else {
    const [inserted] = await tx
      .insert(schema.repositoryBindings)
      .values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        connectionId,
        provider,
        providerRepositoryId: repo.id,
        providerOwner: repo.owner,
        providerName: repo.name,
        providerFullName: repo.fullName,
        configuredDefaultRef: repo.defaultBranch,
        observedAt: now,
        version: latest === undefined ? 1 : latest.version + 1,
        supersedesBindingId: latest === undefined ? null : latest.id,
        createdAt: now,
        createdById: userId,
      })
      .returning({
        id: schema.repositoryBindings.id,
        publicId: schema.repositoryBindings.publicId,
      });
    if (!inserted)
      throw new Error("repository_bindings insert returned no row");
    binding = inserted;
  }

  await tx.insert(schema.repositoryBindingHeads).values({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    connectionId,
    provider,
    providerRepositoryId: repo.id,
    currentBindingId: binding.id,
    // Written out rather than left to the column default: which role a head
    // carries is the whole question `repository_binding_heads_main_repository_uq`
    // answers.
    role,
    createdAt: now,
    updatedAt: now,
  });

  return { bindingPublicId: binding.publicId };
}
