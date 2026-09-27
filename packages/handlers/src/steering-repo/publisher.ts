// steering-repo/publisher.ts: S5's publish() bound to a workspace's steering
// repo in production (steering-repo-spec, Steering PR flow: Publish; S3,
// #4449).
//
// merge_context_pr and the repository sync both publish a steering repo. Each
// merge takes the next version from the version store, so both callers must
// read one store, keyed by one repository string. Two keys for one repository
// would give two merges the same number. This module is that one place:
//
// - steeringRepositoryKey: the key, `github.com/<owner>/<name>`.
// - steeringBundleIdentity: the repository, organization, and workspace a
//   bundle names.
// - steeringPublishDeps: publish()'s deps over the workspace's host and its
//   Postgres version store. `withToolProjection` (M13) adds project().
// - steeringPublisher: what merge_context_pr calls. Its withLock holds the
//   store's lock from the version read through publish(), so the version a
//   merge writes into its trailer is the one publish() assigns.
// - steeringSyncPublish: the repository sync's publish port
//   (`SyncDeps.publish`), over the same publisher.
import { schema, withSystemDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import type { RepoHealth } from "@oxagen/oxagen/steering-repo/health";
import { repoRef } from "@oxagen/oxagen/steering-repo/names";
import {
  type BundleIdentity,
  publish,
  type PublishDeps,
  type PublishResult,
  type SteeringTree,
  type VersionStore,
} from "@oxagen/steering-bundle";
import { and, eq } from "drizzle-orm";
import type {
  SteeringHost,
  SteeringRepository,
} from "../context.steering.github";
import type { SyncPublish, SyncPublished } from "../context.steering.sync";
import { readSteeringLayout } from "./merge-queue";
import {
  heldVersionStore,
  postgresVersionStore,
  type VersionScope,
} from "./version-store";

/** publish() at `commit`, under a lock its caller already holds. */
export type HeldPublish = (commit: string) => Promise<PublishResult>;

/**
 * S5's publish() and the version store it assigns versions from. Both are
 * bound to the same store: the merge reads the next version from `store` and
 * checks that publish() assigned that version.
 */
export interface SteeringPublisher {
  /** The key the store and publish() use for this repository. */
  repository: (repo: SteeringRepository) => string;
  /** The version store publish() assigns versions from. */
  store: Pick<VersionStore, "versionAt" | "highestVersion">;
  /**
   * S5's publish() at `commit`, bound to `store` and the repository. It takes
   * the store's lock itself, so it must never run inside `withLock`: the
   * inner call would wait on the outer one's hold.
   */
  publish: (repo: SteeringRepository, commit: string) => Promise<PublishResult>;
  /**
   * Run `fn` under the store's lock for the repository, across every
   * process. `fn` gets a publish() that runs under that same hold, so no
   * other publish can take a version between `fn`'s read of the store and
   * its publish. A lock another publish holds for over a minute refuses
   * `publish_in_progress` before `fn` runs.
   */
  withLock: <T>(
    repo: SteeringRepository,
    fn: (publish: HeldPublish) => Promise<T>,
  ) => Promise<T>;
}

/** publish()'s deps before MCP Studio adds project(). */
export type SteeringPublishDeps = Omit<PublishDeps, "project">;

export interface SteeringPublishOptions {
  scope: VersionScope;
  host: SteeringHost;
  /** The steering repo's health (S2). Every repository reads healthy until S2 lands. */
  readHealth?: (repo: SteeringRepository) => Promise<RepoHealth>;
  /** The version store. The workspace's Postgres store when unset. */
  store?: VersionStore;
  now?: () => Date;
}

/**
 * The key a steering repo's versions are stored under:
 * `<host>/<owner>/<name>`, lowercased, from the name the binding recorded.
 * A GitLab owner can be a nested group, so the key can hold more than two
 * slashes. A rename on the host does not move the key.
 */
export function steeringRepositoryKey(repo: SteeringRepository): string {
  const cut = repo.fullName.lastIndexOf("/");
  const host = repo.provider === "gitlab" ? "gitlab.com" : "github.com";
  return repoRef(
    host,
    repo.fullName.slice(0, cut),
    repo.fullName.slice(cut + 1),
  );
}

/** The commit the repository's production branch points at now. */
async function productionHead(
  host: SteeringHost,
  repo: SteeringRepository,
): Promise<string> {
  const head = await host.branchHead(repo, repo.defaultBranch);
  if (head === null) {
    throw new HandlerError({
      code: "conflict",
      reason: "production_branch_missing",
      message: `${repo.fullName} has no branch ${repo.defaultBranch}, the production branch its binding approved.`,
    });
  }
  return head;
}

/** The repository, organization, and workspace a workspace's bundle names. */
export async function steeringBundleIdentity(
  scope: VersionScope,
  repo: SteeringRepository,
): Promise<BundleIdentity> {
  // tenancy: organizations and workspaces are platform tables. The read is
  // filtered by the caller's orgId and workspaceId together, as S1's
  // provisioning reads the same slugs.
  const [row] = await withSystemDb((tx) =>
    tx
      .select({
        organization: schema.organizations.slug,
        workspace: schema.workspaces.slug,
      })
      .from(schema.workspaces)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.workspaces.orgId),
      )
      .where(
        and(
          eq(schema.workspaces.id, scope.workspaceId),
          eq(schema.workspaces.orgId, scope.orgId),
        ),
      )
      .limit(1),
  );
  if (!row) {
    throw new HandlerError({
      code: "not_found",
      reason: "workspace_not_found",
      message: `Workspace ${scope.workspaceId} is not in organization ${scope.orgId}, so its steering repo was not published.`,
    });
  }
  return {
    repository: steeringRepositoryKey(repo),
    scope: "workspace",
    organization: row.organization,
    workspace: row.workspace,
  };
}

/**
 * publish()'s deps for one workspace's steering repo: the workspace's version
 * store, the production branch's head, the merged tree with blob ids, and the
 * version tag, all through the workspace's host. Each dep refuses any
 * repository key but this one, so a caller that computed another key fails
 * loudly instead of starting a second version sequence.
 *
 * Both production callers add MCP Studio's project() to these through
 * `withToolProjection` (M13).
 */
export function steeringPublishDeps(
  options: SteeringPublishOptions & { repo: SteeringRepository },
): SteeringPublishDeps {
  const { host, repo } = options;
  const key = steeringRepositoryKey(repo);
  const own = (repository: string) => {
    if (repository !== key) {
      throw new Error(
        `The publish deps for ${key} were called for ${repository}. Compute the key with steeringRepositoryKey.`,
      );
    }
  };
  const readHealth =
    options.readHealth ?? (async (): Promise<RepoHealth> => "healthy");
  // No `compiler` on purpose: publish() and buildBundle() then compile each
  // server folder with MCP Studio's compileServerFolder. Tests pass their own.
  return {
    store: options.store ?? postgresVersionStore(options.scope),
    health: async (repository) => {
      own(repository);
      return readHealth(repo);
    },
    head: async (repository) => {
      own(repository);
      return productionHead(host, repo);
    },
    tree: async (repository, commit): Promise<SteeringTree> => {
      own(repository);
      return {
        list: () => host.listTree(repo, commit),
        read: async (path) => {
          const text = await host.readFile(repo, path, commit);
          if (text === null) {
            throw new Error(
              `${path} is listed in ${repo.fullName} at ${commit}, but the host returned no file.`,
            );
          }
          return text;
        },
      };
    },
    tag: async (repository, name, commit) => {
      own(repository);
      await host.createTag(repo, name, commit);
    },
    now: options.now ?? (() => new Date()),
  };
}

/**
 * The publisher merge_context_pr calls for one workspace. The version store
 * is built once, so the merge's version read and publish() share it.
 * `extend` adds MCP Studio's project() to the deps. The production merge
 * passes `withToolProjection`.
 */
export function steeringPublisher(
  options: SteeringPublishOptions & {
    extend?: (deps: SteeringPublishDeps) => PublishDeps;
  },
): SteeringPublisher {
  const store = options.store ?? postgresVersionStore(options.scope);
  const publishWith = async (
    lockStore: VersionStore,
    repo: SteeringRepository,
    commit: string,
  ) => {
    const deps = steeringPublishDeps({ ...options, store: lockStore, repo });
    return publish(
      options.extend ? options.extend(deps) : deps,
      await steeringBundleIdentity(options.scope, repo),
      commit,
    );
  };
  const held = heldVersionStore(store);
  return {
    repository: steeringRepositoryKey,
    store,
    publish: (repo, commit) => publishWith(store, repo, commit),
    withLock: (repo, fn) =>
      store.withLock(steeringRepositoryKey(repo), () =>
        fn((commit) => publishWith(held, repo, commit)),
      ),
  };
}

/** The options steeringSyncPublish takes. The scope comes from each call. */
export type SteeringSyncPublishOptions = Omit<
  SteeringPublishOptions,
  "scope" | "store"
> & {
  extend?: (deps: SteeringPublishDeps) => PublishDeps;
  /** The version store for a scope. The workspace's Postgres store when unset. */
  store?: (scope: VersionScope) => VersionStore;
};

/**
 * The repository sync's publish port (`SyncDeps.publish`). Each call resolves
 * the workspace's steering head and publishes its production branch's head
 * through the publisher merge_context_pr uses, so a merge made on the host
 * reaches the same version sequence as one made from Oxagen. A repository in
 * the legacy layout has no bundle to publish, and the port answers null.
 *
 * The host resolves a head with either steering role (`STEERING_HEAD_ROLES`):
 * `steering` for the repository S1 provisions, and `main` for a code
 * repository bound before S8 moves it. A workspace with only a provisioned
 * steering repository therefore publishes, and the sync reaches this port.
 *
 * The production sync deps pass `extend: withToolProjection`, so a version the
 * sync publishes also writes the workspace's tool registry.
 */
export function steeringSyncPublish(
  options: SteeringSyncPublishOptions,
): SyncPublish {
  return async (scope) => {
    const { host } = options;
    const repo = await host.resolveRepository(scope);
    if ((await readSteeringLayout(host, repo)).layout !== "steering") {
      return null;
    }
    const publisher = steeringPublisher({
      ...options,
      scope,
      store: options.store?.(scope),
    });
    return syncPublished(
      await publisher.publish(repo, await productionHead(host, repo)),
    );
  };
}

/** What the sync records of one publish. */
export function syncPublished(result: PublishResult): SyncPublished {
  switch (result.status) {
    case "current":
    case "published":
      return { status: result.status, version: result.version };
    case "refused":
    case "stale":
      return { status: result.status, version: null };
  }
}
