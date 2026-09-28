// steering-repo/version-store.ts: the published steering versions in
// Postgres (steering-repo-spec, Steering PR flow: Publish; S3, #4449).
//
// S5's publish() assigns each merge of a steering repository the next
// version, keeps every version it builds, and switches the published one in
// one write. This is the store it does that through in production.
// `steering_versions` holds each built version, published or not, so a
// number is never reused. `steering_publications` holds one row per
// repository: the published version, and the publish lease.
//
// One publish of a repository runs at a time, across every process. withLock
// takes a lease on the repository's row: a random token and an expiry five
// minutes out, written only while no other lease is live. A process that dies
// holding it frees it when the expiry passes, and a live publish extends it
// every third of that. setPublished moves the pointer
// only while this call's token still holds the lease, and only forward, so a
// publisher whose lease lapsed mid-build cannot roll the published version
// back.
//
// Each method opens the scope's tenant transaction and filters by the scope
// as well, so one missing policy still leaks no row.
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import {
  type Bundle,
  bundleSchema,
} from "@oxagen/oxagen/steering-repo/bundle";
import type {
  PublishedPointer,
  StoredVersion,
  VersionStore,
} from "@oxagen/steering-bundle";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, desc, eq, isNull, lt, max, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { logger } from "../logger";

/** The workspace a store reads and writes. */
export interface VersionScope {
  orgId: string;
  workspaceId: string;
}

export interface VersionStoreOptions {
  /** How long a lease holds before another publish may take it. */
  leaseSeconds?: number;
  /** How long withLock waits for another publish before it refuses. */
  waitMs?: number;
}

const LEASE_SECONDS = 300;
const WAIT_MS = 60_000;
const FIRST_POLL_MS = 250;
const LAST_POLL_MS = 2_000;

// The publishes this process runs, queued per repository, so two in one
// process wait on each other here instead of polling the lease.
const queues = new Map<string, Promise<unknown>>();
// The lease token each running publish holds, by repository.
const held = new Map<string, string>();

const inScope = <T>(scope: VersionScope, fn: (tx: Tx) => Promise<T>) =>
  runInTenantScope(scope, () => withTenantDb(fn));

const scoped = (
  table: { orgId: PgColumn; workspaceId: PgColumn },
  scope: VersionScope,
) =>
  and(eq(table.orgId, scope.orgId), eq(table.workspaceId, scope.workspaceId));

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `store` for a publish() that runs inside a withLock its caller holds. Its
 * withLock runs `fn` at once, since taking the lock again would wait on the
 * caller's own hold. Every other method is the store's own. The Postgres
 * store's setPublished reads the lease token the caller's withLock took, so
 * a hold that lapsed still publishes nothing.
 */
export function heldVersionStore(store: VersionStore): VersionStore {
  return {
    withLock: <T>(_repository: string, fn: () => Promise<T>) => fn(),
    current: (repository) => store.current(repository),
    highestVersion: (repository) => store.highestVersion(repository),
    versionAt: (repository, commit) => store.versionAt(repository, commit),
    put: (bundle) => store.put(bundle),
    setPublished: (repository, pointer) =>
      store.setPublished(repository, pointer),
  };
}

/** The published steering versions of one workspace, in Postgres. */
export function postgresVersionStore(
  scope: VersionScope,
  options: VersionStoreOptions = {},
): VersionStore {
  const leaseSeconds = options.leaseSeconds ?? LEASE_SECONDS;
  const waitMs = options.waitMs ?? WAIT_MS;
  const versions = schema.steeringVersions;
  const publications = schema.steeringPublications;
  const keyOf = (repository: string) => `${scope.workspaceId}#${repository}`;
  const leaseEnd = sql`now() + make_interval(secs => ${leaseSeconds})`;

  /** Take the lease when no other is live. True when this token holds it. */
  async function tryLease(repository: string, token: string): Promise<boolean> {
    const rows = await inScope(scope, (tx) =>
      tx
        .insert(publications)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          repository,
          leaseToken: token,
          leaseUntil: leaseEnd,
        })
        .onConflictDoUpdate({
          target: [publications.workspaceId, publications.repository],
          set: { leaseToken: token, leaseUntil: leaseEnd, updatedAt: sql`now()` },
          setWhere: sql`${publications.leaseUntil} IS NULL OR ${publications.leaseUntil} < now()`,
        })
        .returning({ id: publications.id }),
    );
    return rows.length > 0;
  }

  async function lease(repository: string, token: string): Promise<void> {
    const deadline = Date.now() + waitMs;
    let pause = FIRST_POLL_MS;
    while (!(await tryLease(repository, token))) {
      if (Date.now() + pause > deadline) {
        throw new HandlerError({
          code: "conflict",
          reason: "publish_in_progress",
          message: `Another publish of ${repository} held its lock for over ${Math.round(waitMs / 1000)} seconds. The next sync publishes it again.`,
        });
      }
      await sleep(pause);
      pause = Math.min(pause * 2, LAST_POLL_MS);
    }
  }

  /** Push the lease's expiry out again while this token holds it. */
  async function extend(repository: string, token: string): Promise<void> {
    try {
      await inScope(scope, (tx) =>
        tx
          .update(publications)
          .set({ leaseUntil: leaseEnd, updatedAt: sql`now()` })
          .where(
            and(
              scoped(publications, scope),
              eq(publications.repository, repository),
              eq(publications.leaseToken, token),
            ),
          ),
      );
    } catch (err) {
      // setPublished checks the token, so a lease lost here publishes nothing.
      logger.warn(
        { err, repository, workspaceId: scope.workspaceId },
        "steering-repo: could not extend the publish lease",
      );
    }
  }

  async function release(repository: string, token: string): Promise<void> {
    try {
      await inScope(scope, (tx) =>
        tx
          .update(publications)
          .set({ leaseToken: null, leaseUntil: null, updatedAt: sql`now()` })
          .where(
            and(
              scoped(publications, scope),
              eq(publications.repository, repository),
              eq(publications.leaseToken, token),
            ),
          ),
      );
    } catch (err) {
      // The lease lapses on its own, so the next publish waits at most that.
      logger.warn(
        { err, repository, workspaceId: scope.workspaceId },
        "steering-repo: could not release the publish lease; it lapses on its own",
      );
    }
  }

  return {
    withLock<T>(repository: string, fn: () => Promise<T>): Promise<T> {
      const key = keyOf(repository);
      const run = async () => {
        const token = crypto.randomUUID();
        await lease(repository, token);
        held.set(key, token);
        const renew = setInterval(
          () => void extend(repository, token),
          (leaseSeconds * 1000) / 3,
        );
        renew.unref?.();
        try {
          return await fn();
        } finally {
          clearInterval(renew);
          held.delete(key);
          await release(repository, token);
        }
      };
      const before = queues.get(key) ?? Promise.resolve();
      const result = before.then(run, run);
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      queues.set(key, settled);
      void settled.then(() => {
        if (queues.get(key) === settled) queues.delete(key);
      });
      return result;
    },

    async current(repository: string): Promise<Bundle | null> {
      const [row] = await inScope(scope, (tx) =>
        tx
          .select({ bundle: versions.bundle })
          .from(publications)
          .innerJoin(
            versions,
            and(
              eq(versions.orgId, publications.orgId),
              eq(versions.workspaceId, publications.workspaceId),
              eq(versions.repository, publications.repository),
              eq(versions.version, publications.publishedVersion),
            ),
          )
          .where(
            and(
              scoped(publications, scope),
              eq(publications.repository, repository),
            ),
          )
          .limit(1),
      );
      return row ? bundleSchema.parse(row.bundle) : null;
    },

    async highestVersion(repository: string): Promise<number> {
      const [row] = await inScope(scope, (tx) =>
        tx
          .select({ high: max(versions.version) })
          .from(versions)
          .where(
            and(scoped(versions, scope), eq(versions.repository, repository)),
          ),
      );
      return row?.high ?? 0;
    },

    async versionAt(
      repository: string,
      commit: string,
    ): Promise<StoredVersion | null> {
      const [row] = await inScope(scope, (tx) =>
        tx
          .select({
            version: versions.version,
            publishedAt: versions.publishedAt,
          })
          .from(versions)
          .where(
            and(
              scoped(versions, scope),
              eq(versions.repository, repository),
              eq(versions.commitSha, commit),
            ),
          )
          .orderBy(desc(versions.version))
          .limit(1),
      );
      return row
        ? { version: row.version, published: row.publishedAt !== null }
        : null;
    },

    async put(bundle: Bundle): Promise<void> {
      await inScope(scope, (tx) =>
        tx.insert(versions).values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          repository: bundle.repository,
          version: bundle.version,
          commitSha: bundle.commit,
          bundle,
        }),
      );
    },

    async setPublished(
      repository: string,
      pointer: PublishedPointer,
    ): Promise<void> {
      const token = held.get(keyOf(repository));
      if (token === undefined) {
        throw new Error(
          `Version ${pointer.version} of ${repository} was not published: setPublished runs only inside withLock.`,
        );
      }
      await inScope(scope, async (tx) => {
        const moved = await tx
          .update(publications)
          .set({
            publishedVersion: pointer.version,
            publishedCommit: pointer.commit,
            ledger: pointer.ledger,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              scoped(publications, scope),
              eq(publications.repository, repository),
              eq(publications.leaseToken, token),
              or(
                isNull(publications.publishedVersion),
                lt(publications.publishedVersion, pointer.version),
              ),
            ),
          )
          .returning({ id: publications.id });
        if (moved.length === 0) {
          throw new HandlerError({
            code: "conflict",
            reason: "publish_lease_lost",
            message: `Version ${pointer.version} of ${repository} was not published: this publish no longer holds the lock, or a later version is already published.`,
          });
        }
        const named = await tx
          .update(versions)
          .set({ publishedAt: sql`coalesce(${versions.publishedAt}, now())` })
          .where(
            and(
              scoped(versions, scope),
              eq(versions.repository, repository),
              eq(versions.version, pointer.version),
              eq(versions.commitSha, pointer.commit),
            ),
          )
          .returning({ id: versions.id });
        if (named.length === 0) {
          // Thrown inside the transaction, so the pointer above rolls back.
          throw new Error(
            `Version ${pointer.version} of ${repository} at ${pointer.commit} is not stored, so it was not published.`,
          );
        }
      });
    },
  };
}
