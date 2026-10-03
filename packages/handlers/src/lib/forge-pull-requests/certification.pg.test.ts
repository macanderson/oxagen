// The witness's queue against a real Postgres (ADR-294):
//   - a stored revision is queued once, however often its event arrives
//   - a later delivery reads back the state the witness left
//   - a revision another workspace or another pull request holds is `gone`
//   - a decided row needs its time, and a pending row holds no verdict
//   - the migration's backfill queues stored revisions and only those
//   - a row goes with its pull request
//
// Runs wherever DATABASE_URL points at a migrated database: CI's unit
// (handlers) lane migrates Postgres with Atlas first. On CI a missing
// DATABASE_URL fails the file instead of skipping it. Every row it writes is
// removed in afterAll.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import type {
  ForgePullRequestCapture,
  ForgePullRequestFacts,
} from "@oxagen/inngest-functions/forge-pull-request-sync-runner";
import { and, eq, sql } from "drizzle-orm";
import { queueCertification } from "./certification";
import { recordRevision, type Scope, upsertPullRequest } from "./store";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled)
  throw new Error("The certification queue test needs DATABASE_URL on CI.");

const sha = (c: string) => c.repeat(40);

function facts(number: number): ForgePullRequestFacts {
  return {
    host: "github.com",
    providerRepositoryId: "300",
    repository: "acme/api",
    number,
    url: `https://github.com/acme/api/pull/${String(number)}`,
    title: `Pull request ${String(number)}`,
    authorLogin: "dev",
    state: "open",
    draft: false,
    baseRef: "main",
    headRef: `feat/${String(number)}`,
    headSha: sha("a"),
    baseSha: null,
    mergeBaseSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    sourceUpdatedAt: null,
  };
}

function stored(head: string): ForgePullRequestCapture {
  return {
    diffStatus: "stored",
    diffStore: "s3",
    diffKey: `pr-diffs/test/${head}.diff`,
    diffSha256: "e".repeat(64),
    diffBytes: 10,
    mergeBaseSha: null,
    files: [],
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    complete: true,
    limitations: [],
  };
}

const UNCONFIGURED: ForgePullRequestCapture = {
  ...stored("none"),
  diffStatus: "unconfigured",
  diffStore: null,
  diffKey: null,
  diffSha256: null,
  diffBytes: null,
  complete: false,
};

/** The migration's backfill statement, run as the migration runs it. */
function backfillStatement(): string {
  const file = fileURLToPath(
    new URL(
      "../../../../database/atlas/migrations/20261003210000_forge_revision_certifications.sql",
      import.meta.url,
    ),
  );
  const text = readFileSync(file, "utf8");
  const start = text.indexOf("INSERT INTO forge.revision_certifications");
  if (start < 0) throw new Error("The migration has no backfill statement.");
  return text.slice(start).trim();
}

describe.skipIf(!enabled)(
  "the witness's certification queue",
  { timeout: 60_000 },
  () => {
    const scope: Scope = {
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    };
    const other: Scope = {
      orgId: scope.orgId,
      workspaceId: crypto.randomUUID(),
    };
    let pullRequestId = "";
    let firstRevision = "";
    let laterRevision = "";
    let unstoredRevision = "";
    let otherPullRequestId = "";
    let otherRevision = "";

    const rowsFor = (revisionId: string) =>
      withSystemDb((tx) =>
        tx
          .select()
          .from(schema.forgeRevisionCertifications)
          .where(eq(schema.forgeRevisionCertifications.revisionId, revisionId)),
      );

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        const seen = new Date("2026-10-03T10:00:00Z");
        pullRequestId = await upsertPullRequest(tx, scope, "github", facts(1), seen);
        firstRevision = (
          await recordRevision(
            tx,
            scope,
            pullRequestId,
            { headSha: sha("a"), baseSha: null },
            stored("a"),
            seen,
          )
        ).revisionId;
        laterRevision = (
          await recordRevision(
            tx,
            scope,
            pullRequestId,
            { headSha: sha("b"), baseSha: null },
            stored("b"),
            new Date("2026-10-03T11:00:00Z"),
          )
        ).revisionId;
        unstoredRevision = (
          await recordRevision(
            tx,
            scope,
            pullRequestId,
            { headSha: sha("c"), baseSha: null },
            UNCONFIGURED,
            seen,
          )
        ).revisionId;
        otherPullRequestId = await upsertPullRequest(
          tx,
          other,
          "github",
          facts(2),
          seen,
        );
        otherRevision = (
          await recordRevision(
            tx,
            other,
            otherPullRequestId,
            { headSha: sha("d"), baseSha: null },
            stored("d"),
            seen,
          )
        ).revisionId;
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        // Revisions and certifications cascade from their pull request.
        await tx
          .delete(schema.forgePullRequests)
          .where(eq(schema.forgePullRequests.orgId, scope.orgId));
      });
      await closeDatabase();
    });

    it("queues a stored revision once, however often its event arrives", async () => {
      const request = { pullRequestId, revisionId: firstRevision };
      const first = await withSystemDb((tx) =>
        queueCertification(tx, scope, request),
      );
      const again = await withSystemDb((tx) =>
        queueCertification(tx, scope, request),
      );
      expect(first).toMatchObject({ outcome: "queued", state: "pending" });
      expect(first.certificationId).toMatch(/^rcf_/);
      expect(again).toEqual({
        outcome: "existing",
        certificationId: first.certificationId,
        state: "pending",
      });
      const rows = await rowsFor(firstRevision);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        pullRequestId,
        state: "pending",
        decidedAt: null,
        verdict: null,
      });
    });

    it("reads back the state the witness left", async () => {
      await withSystemDb((tx) =>
        tx
          .update(schema.forgeRevisionCertifications)
          .set({
            state: "certified",
            decidedAt: new Date("2026-10-03T12:00:00Z"),
            verdict: { checks: 3 },
          })
          .where(
            eq(schema.forgeRevisionCertifications.revisionId, firstRevision),
          ),
      );
      const again = await withSystemDb((tx) =>
        queueCertification(tx, scope, {
          pullRequestId,
          revisionId: firstRevision,
        }),
      );
      expect(again).toMatchObject({ outcome: "existing", state: "certified" });
    });

    it("answers gone for another workspace's revision or another pull request's (negative)", async () => {
      const foreign = await withSystemDb((tx) =>
        queueCertification(tx, scope, {
          pullRequestId: otherPullRequestId,
          revisionId: otherRevision,
        }),
      );
      const mismatched = await withSystemDb((tx) =>
        queueCertification(tx, scope, {
          pullRequestId: otherPullRequestId,
          revisionId: laterRevision,
        }),
      );
      const wrongScope = await withSystemDb((tx) =>
        queueCertification(tx, other, {
          pullRequestId,
          revisionId: laterRevision,
        }),
      );
      for (const outcome of [foreign, mismatched, wrongScope])
        expect(outcome).toEqual({
          outcome: "gone",
          certificationId: null,
          state: null,
        });
      expect(await rowsFor(otherRevision)).toHaveLength(0);
      expect(await rowsFor(laterRevision)).toHaveLength(0);
    });

    it("refuses a decided row with no time and a pending row with a verdict (negative)", async () => {
      const certifications = schema.forgeRevisionCertifications;
      const where = eq(certifications.revisionId, firstRevision);
      await expect(
        withSystemDb((tx) =>
          tx
            .update(certifications)
            .set({ state: "rejected", decidedAt: null })
            .where(where),
        ),
      ).rejects.toThrow();
      await expect(
        withSystemDb((tx) =>
          tx
            .update(certifications)
            .set({ state: "pending", decidedAt: null, verdict: { checks: 1 } })
            .where(where),
        ),
      ).rejects.toThrow();
      await expect(
        withSystemDb((tx) =>
          tx.update(certifications).set({ state: "waiting" }).where(where),
        ),
      ).rejects.toThrow();
    });

    it("backfills stored revisions with no row, and only those, as the migration does", async () => {
      await withSystemDb((tx) => tx.execute(sql.raw(backfillStatement())));
      const later = await rowsFor(laterRevision);
      expect(later).toHaveLength(1);
      expect(later[0]).toMatchObject({
        pullRequestId,
        state: "pending",
        requestedAt: new Date("2026-10-03T11:00:00Z"),
      });
      expect(later[0]?.publicId).toMatch(/^rcf_[0-9a-f]{22}$/);
      expect(await rowsFor(unstoredRevision)).toHaveLength(0);
      // The row the witness decided keeps its state.
      expect((await rowsFor(firstRevision))[0]?.state).toBe("certified");
    });

    it("removes a pull request's rows with the pull request", async () => {
      await withSystemDb((tx) =>
        tx
          .delete(schema.forgePullRequests)
          .where(
            and(
              eq(schema.forgePullRequests.orgId, scope.orgId),
              eq(schema.forgePullRequests.id, pullRequestId),
            ),
          ),
      );
      expect(await rowsFor(firstRevision)).toHaveLength(0);
      expect(await rowsFor(laterRevision)).toHaveLength(0);
    });
  },
);
