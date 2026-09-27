// The published steering versions store against Postgres (S3, #4449). It
// runs where DATABASE_URL names a migrated database, as in CI's unit lanes.
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import { and, eq, inArray } from "drizzle-orm";
import { postgresVersionStore, type VersionScope } from "./version-store";

const REPOSITORY = "github.com/a-intel/steering";
const scopes: VersionScope[] = [];

function newScope(): VersionScope {
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  scopes.push(scope);
  return scope;
}

/** A 40-hex commit id that ends in `n`. */
const commit = (n: number) => n.toString(16).padStart(40, "0");

function bundle(version: number, at: string): Bundle {
  return {
    schema: "bundle/v1",
    repository: REPOSITORY,
    scope: "workspace",
    organization: "a-intel",
    workspace: "platform",
    version,
    commit: at,
    ledger: null,
    published_at: "2026-09-27T12:00:00Z",
    records: [],
    always_on: [],
    policies: null,
    agents: [],
    tools: null,
  } as Bundle;
}

async function publishOne(
  store: ReturnType<typeof postgresVersionStore>,
  version: number,
  at: string,
) {
  await store.withLock(REPOSITORY, async () => {
    await store.put(bundle(version, at));
    await store.setPublished(REPOSITORY, {
      version,
      commit: at,
      ledger: null,
    });
  });
}

describe.skipIf(!process.env.DATABASE_URL)(
  "the published steering versions in Postgres",
  () => {
    afterAll(async () => {
      const workspaces = scopes.map((scope) => scope.workspaceId);
      if (workspaces.length > 0)
        await withSystemDb(async (tx) => {
          await tx
            .delete(schema.steeringVersions)
            .where(inArray(schema.steeringVersions.workspaceId, workspaces));
          await tx
            .delete(schema.steeringPublications)
            .where(
              inArray(schema.steeringPublications.workspaceId, workspaces),
            );
        });
      await closeDatabase();
    });

    it("keeps every version, and names the published one", async () => {
      const store = postgresVersionStore(newScope());
      await expect(store.current(REPOSITORY)).resolves.toBeNull();
      await expect(store.highestVersion(REPOSITORY)).resolves.toBe(0);
      await expect(store.versionAt(REPOSITORY, commit(1))).resolves.toBeNull();

      await publishOne(store, 1, commit(1));
      await expect(store.current(REPOSITORY)).resolves.toMatchObject({
        version: 1,
        commit: commit(1),
      });
      await expect(store.versionAt(REPOSITORY, commit(1))).resolves.toEqual({
        version: 1,
        published: true,
      });

      // A version stored and never published keeps its number.
      await store.withLock(REPOSITORY, () => store.put(bundle(2, commit(2))));
      await expect(store.highestVersion(REPOSITORY)).resolves.toBe(2);
      await expect(store.versionAt(REPOSITORY, commit(2))).resolves.toEqual({
        version: 2,
        published: false,
      });
      await expect(store.current(REPOSITORY)).resolves.toMatchObject({
        version: 1,
      });
    });

    it("answers the newest version built from a commit", async () => {
      const store = postgresVersionStore(newScope());
      await publishOne(store, 1, commit(1));
      await store.withLock(REPOSITORY, () => store.put(bundle(2, commit(1))));
      await expect(store.versionAt(REPOSITORY, commit(1))).resolves.toEqual({
        version: 2,
        published: false,
      });
    });

    it("refuses a number already stored", async () => {
      const store = postgresVersionStore(newScope());
      await publishOne(store, 1, commit(1));
      await expect(
        store.withLock(REPOSITORY, () => store.put(bundle(1, commit(2)))),
      ).rejects.toThrow();
    });

    it("never moves the published version back", async () => {
      const store = postgresVersionStore(newScope());
      await store.withLock(REPOSITORY, () => store.put(bundle(1, commit(1))));
      await publishOne(store, 2, commit(2));
      await expect(
        store.withLock(REPOSITORY, () =>
          store.setPublished(REPOSITORY, {
            version: 1,
            commit: commit(1),
            ledger: null,
          }),
        ),
      ).rejects.toMatchObject({ reason: "publish_lease_lost" });
      await expect(store.current(REPOSITORY)).resolves.toMatchObject({
        version: 2,
      });
    });

    it("publishes nothing outside the lock, and nothing it did not store", async () => {
      const store = postgresVersionStore(newScope());
      await publishOne(store, 1, commit(1));
      await expect(
        store.setPublished(REPOSITORY, {
          version: 2,
          commit: commit(2),
          ledger: null,
        }),
      ).rejects.toThrow("only inside withLock");
      await expect(
        store.withLock(REPOSITORY, () =>
          store.setPublished(REPOSITORY, {
            version: 3,
            commit: commit(3),
            ledger: null,
          }),
        ),
      ).rejects.toThrow("is not stored");
      // The pointer write rolled back with the refusal.
      await expect(store.current(REPOSITORY)).resolves.toMatchObject({
        version: 1,
      });
    });

    it("runs one publish of a repository at a time in one process", async () => {
      const store = postgresVersionStore(newScope());
      const order: string[] = [];
      const run = (name: string) =>
        store.withLock(REPOSITORY, async () => {
          order.push(`${name} start`);
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push(`${name} end`);
        });
      await Promise.all([run("a"), run("b")]);
      expect(order).toEqual(["a start", "a end", "b start", "b end"]);
    });

    it("waits for another process's live lease, and takes one that lapsed", async () => {
      const scope = newScope();
      await withSystemDb((tx) =>
        tx.insert(schema.steeringPublications).values({
          ...scope,
          repository: REPOSITORY,
          leaseToken: crypto.randomUUID(),
          leaseUntil: new Date(Date.now() + 3_600_000),
        }),
      );
      const store = postgresVersionStore(scope, { waitMs: 300 });
      await expect(
        store.withLock(REPOSITORY, async () => "ran"),
      ).rejects.toMatchObject({ reason: "publish_in_progress" });

      await withSystemDb((tx) =>
        tx
          .update(schema.steeringPublications)
          .set({ leaseUntil: new Date(Date.now() - 1_000) })
          .where(
            and(
              eq(schema.steeringPublications.workspaceId, scope.workspaceId),
              eq(schema.steeringPublications.repository, REPOSITORY),
            ),
          ),
      );
      await expect(store.withLock(REPOSITORY, async () => "ran")).resolves.toBe(
        "ran",
      );
      // The lease is released when the publish ends.
      const [row] = await withSystemDb((tx) =>
        tx
          .select({ token: schema.steeringPublications.leaseToken })
          .from(schema.steeringPublications)
          .where(
            eq(schema.steeringPublications.workspaceId, scope.workspaceId),
          ),
      );
      expect(row?.token).toBeNull();
    });

    it("shows one workspace none of another's versions", async () => {
      const one = postgresVersionStore(newScope());
      await publishOne(one, 1, commit(1));
      const other = postgresVersionStore(newScope());
      await expect(other.current(REPOSITORY)).resolves.toBeNull();
      await expect(other.highestVersion(REPOSITORY)).resolves.toBe(0);
      await expect(other.versionAt(REPOSITORY, commit(1))).resolves.toBeNull();
    });
  },
);
