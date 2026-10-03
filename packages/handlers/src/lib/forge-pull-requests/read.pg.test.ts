// A change set's scopes resolved against a real Postgres (ADR-292):
//   - a wrapped run that only `tacho.run_pull_requests` names, with no forge
//     link of its own
//   - a work order through its forge link
//   - a work item through the issue it came from (`issue:node:<id>`) and
//     through its work order
//   - an issue through its closing references and through the work item that
//     came from it
//   - a work order and a work item no row names, which are not_found
//   - the roll-up, which lists a pull request closed unmerged and leaves it out
//   - another workspace's rows, which are never read
//
// Runs wherever DATABASE_URL points at a migrated database: CI's unit
// (handlers) lane migrates Postgres with Atlas first. On CI a missing
// DATABASE_URL fails the file instead of skipping it. Every row it writes is
// removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import type {
  ForgePullRequestCapture,
  ForgePullRequestFacts,
} from "@oxagen/inngest-functions/forge-pull-request-sync-runner";
import { eq } from "drizzle-orm";
import { readChangeSet } from "./read";
import {
  linkWorkOrders,
  recordRevision,
  replaceIssueLinks,
  type Scope,
  upsertPullRequest,
} from "./store";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled)
  throw new Error("The change set scope test needs DATABASE_URL on CI.");

const sha = (c: string) => c.repeat(40);

function facts(
  over: Partial<ForgePullRequestFacts> &
    Pick<ForgePullRequestFacts, "repository" | "number">,
): ForgePullRequestFacts {
  return {
    host: "github.com",
    providerRepositoryId: "200",
    url: `https://github.com/${over.repository}/pull/${String(over.number)}`,
    title: `Pull request ${String(over.number)}`,
    authorLogin: "dev",
    state: "open",
    draft: false,
    baseRef: "main",
    headRef: `feat/${String(over.number)}`,
    headSha: sha("a"),
    baseSha: null,
    mergeBaseSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    sourceUpdatedAt: null,
    ...over,
  };
}

function capture(
  files: ForgePullRequestCapture["files"],
): ForgePullRequestCapture {
  return {
    diffStatus: "unconfigured",
    diffStore: null,
    diffKey: null,
    diffSha256: null,
    diffBytes: null,
    mergeBaseSha: null,
    files,
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    complete: false,
    limitations: [],
  };
}

const ISSUE_URL = "https://github.com/acme/api/issues/7";

describe.skipIf(!enabled)(
  "change set scopes against the forge store",
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
    const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const RUN = `tse_${tag}changeset0000`;
    const sessionUuid = crypto.randomUUID();
    const itemNumber = `CS-${tag}`;
    let itemPublicId = "";
    let orderPublicId = "";

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        // A wrapped run whose only record of its pull request is the
        // tacho row ADR-192 wrote: no forge link.
        const [session] = await tx
          .insert(schema.tachoSessions)
          .values({
            publicId: RUN,
            ...scope,
            sessionUuid,
            harnessSessionId: `sess-${tag}`,
            agentKey: `changes.bot-${tag}`,
            rootSessionUuid: sessionUuid,
            parentSessionUuid: null,
            runtime: "claude-code",
            harness: "claude-code",
            startedAt: new Date("2026-10-03T09:00:00Z"),
            lastEventAt: new Date("2026-10-03T09:30:00Z"),
            sealedAt: null,
            seqCount: 1,
            lastHash: `sha256:${"a".repeat(64)}`,
            numToolCalls: 0,
            toolBodyFrames: 0,
            contentFrames: 0,
            bodyFrames: 0,
          })
          .returning({ id: schema.tachoSessions.id });
        await tx.insert(schema.tachoRunPullRequests).values({
          ...scope,
          sessionId: session!.id,
          url: "https://github.com/acme/api/pull/1",
          provider: "github",
          repository: "acme/api",
          number: 1,
        });
        const run = await upsertPullRequest(
          tx,
          scope,
          "github",
          facts({ repository: "acme/api", number: 1 }),
          new Date("2026-10-03T10:00:00Z"),
        );
        await recordRevision(
          tx,
          scope,
          run,
          { headSha: sha("a"), baseSha: null },
          capture([
            {
              path: "src/shared.ts",
              status: "modified",
              additions: 2,
              deletions: 1,
            },
          ]),
          new Date("2026-10-03T10:00:00Z"),
        );

        // Two pull requests close the issue. One merged, one closed unmerged.
        const merged = await upsertPullRequest(
          tx,
          scope,
          "github",
          facts({
            repository: "acme/api",
            number: 2,
            state: "merged",
            mergeCommitSha: sha("c"),
            mergedAt: "2026-10-03T11:00:00.000Z",
          }),
          new Date("2026-10-03T11:00:00Z"),
        );
        await recordRevision(
          tx,
          scope,
          merged,
          { headSha: sha("a"), baseSha: null },
          capture([
            {
              path: "src/shared.ts",
              status: "modified",
              additions: 3,
              deletions: 0,
            },
            { path: "src/b.ts", status: "added", additions: 4, deletions: 0 },
          ]),
          new Date("2026-10-03T11:00:00Z"),
        );
        const closed = await upsertPullRequest(
          tx,
          scope,
          "github",
          facts({ repository: "acme/api", number: 3, state: "closed" }),
          new Date("2026-10-03T09:00:00Z"),
        );
        await recordRevision(
          tx,
          scope,
          closed,
          { headSha: sha("a"), baseSha: null },
          capture([
            { path: "src/c.ts", status: "added", additions: 9, deletions: 0 },
          ]),
          new Date("2026-10-03T09:00:00Z"),
        );
        const issue = {
          nodeId: `I_${tag}`,
          repository: "acme/api",
          number: 7,
          url: ISSUE_URL,
          title: "Checkout fails on retry",
          state: "open" as const,
        };
        await replaceIssueLinks(tx, scope, merged, [issue]);
        await replaceIssueLinks(tx, scope, closed, [issue]);

        // A work item that came from the issue.
        const [item] = await tx
          .insert(schema.workItems)
          .values({
            ...scope,
            number: itemNumber,
            subject: "Checkout fails on retry",
            origin: "provider",
            providerId: `issue:node:I_${tag}`,
            sourceUrl: ISSUE_URL,
          })
          .returning({
            id: schema.workItems.id,
            publicId: schema.workItems.publicId,
          });
        itemPublicId = String(item!.publicId);

        // The item's first send, which opened a pull request in another
        // repository. No issue names that pull request.
        const digest = `sha256:${"b".repeat(64)}`;
        const [brief] = await tx
          .insert(schema.workBriefs)
          .values({
            ...scope,
            itemId: item!.id,
            revision: 1,
            itemRevision: 1,
            body: {},
            digest,
            author: "triage",
          })
          .returning({ id: schema.workBriefs.id });
        const [order] = await tx
          .insert(schema.workOrders)
          .values({
            ...scope,
            itemId: item!.id,
            itemRevision: 1,
            send: 1,
            briefId: brief!.id,
            briefRevision: 1,
            briefDigest: digest,
            idempotencyKey: `${item!.id}:r1:s1`,
            agentId: crypto.randomUUID(),
            runtimeId: crypto.randomUUID(),
            runtimeTier: "gateway",
            operatorId: crypto.randomUUID(),
            repository: "acme/web",
          })
          .returning({
            id: schema.workOrders.id,
            publicId: schema.workOrders.publicId,
          });
        orderPublicId = String(order!.publicId);
        const sent = await upsertPullRequest(
          tx,
          scope,
          "github",
          facts({
            providerRepositoryId: "201",
            repository: "acme/web",
            number: 4,
          }),
          new Date("2026-10-03T10:30:00Z"),
        );
        await recordRevision(
          tx,
          scope,
          sent,
          { headSha: sha("a"), baseSha: null },
          capture([
            {
              path: "web/page.tsx",
              status: "modified",
              additions: 5,
              deletions: 2,
            },
          ]),
          new Date("2026-10-03T10:30:00Z"),
        );
        await linkWorkOrders(tx, scope, sent, [order!.id], null);

        // The same pull request number and issue in another workspace.
        const foreign = await upsertPullRequest(
          tx,
          other,
          "github",
          facts({ repository: "acme/api", number: 9 }),
          new Date("2026-10-03T12:00:00Z"),
        );
        await replaceIssueLinks(tx, other, foreign, [issue]);
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        // Revisions and links cascade from their pull request.
        await tx
          .delete(schema.forgePullRequests)
          .where(eq(schema.forgePullRequests.orgId, scope.orgId));
        await tx
          .delete(schema.tachoRunPullRequests)
          .where(eq(schema.tachoRunPullRequests.orgId, scope.orgId));
        await tx
          .delete(schema.tachoSessions)
          .where(eq(schema.tachoSessions.orgId, scope.orgId));
        await tx
          .delete(schema.workOrders)
          .where(eq(schema.workOrders.orgId, scope.orgId));
        await tx
          .delete(schema.workBriefs)
          .where(eq(schema.workBriefs.orgId, scope.orgId));
        await tx
          .delete(schema.workItems)
          .where(eq(schema.workItems.orgId, scope.orgId));
      });
      await closeDatabase();
    });

    const read = (kind: Parameters<typeof readChangeSet>[2], id: string) =>
      withSystemDb((tx) => readChangeSet(tx, scope, kind, id));

    it("reads a wrapped run's pull request that only its tacho row names", async () => {
      const out = await read("run", RUN);
      if (out === "not_found") throw new Error("the run read nothing");
      expect(out.pullRequests.map((pull) => pull.number)).toEqual([1]);
      expect(out.repositories[0]).toMatchObject({
        repository: "acme/api",
        pullRequests: 1,
        additions: 2,
        deletions: 1,
      });
    });

    it("reads a work order's pull request through its forge link", async () => {
      const out = await read("work_order", orderPublicId);
      if (out === "not_found") throw new Error("the work order read nothing");
      expect(out.pullRequests.map((pull) => pull.number)).toEqual([4]);
      expect(out.repositories).toEqual([
        expect.objectContaining({
          repository: "acme/web",
          pullRequests: 1,
          additions: 5,
          deletions: 2,
        }),
      ]);
    });

    it("reads an issue's pull requests through its links and its work item, and leaves the closed one out of the roll-up", async () => {
      const out = await read("issue", ISSUE_URL);
      if (out === "not_found") throw new Error("the issue read nothing");
      expect(
        out.pullRequests.map((pull) => [pull.number, pull.state]),
      ).toEqual([
        [2, "merged"],
        [4, "open"],
        [3, "closed"],
      ]);
      expect(out.repositories).toEqual([
        expect.objectContaining({
          repository: "acme/api",
          pullRequests: 1,
          filesChanged: 2,
          additions: 7,
          deletions: 0,
        }),
        expect.objectContaining({
          repository: "acme/web",
          pullRequests: 1,
          filesChanged: 1,
          additions: 5,
          deletions: 2,
        }),
      ]);
      expect(out.repositories[0]?.files.map((file) => file.path)).toEqual([
        "src/b.ts",
        "src/shared.ts",
      ]);
    });

    it("reads a work item's pull requests through the issue it came from and its work order", async () => {
      const out = await read("work_item", itemPublicId);
      if (out === "not_found") throw new Error("the work item read nothing");
      expect(out.pullRequests.map((pull) => pull.number)).toEqual([2, 4, 3]);
    });

    it("is not_found for a work order and a work item no row names (negative)", async () => {
      await expect(read("work_order", "wo_missing0000")).resolves.toBe(
        "not_found",
      );
      await expect(read("work_item", "wi_missing0000")).resolves.toBe(
        "not_found",
      );
    });

    it("never reads another workspace's links to the same issue (negative)", async () => {
      const out = await read("issue", ISSUE_URL);
      if (out === "not_found") throw new Error("the issue read nothing");
      expect(out.pullRequests.some((pull) => pull.number === 9)).toBe(false);
    });
  },
);
