// A run's pull requests read from the forge store against a real Postgres
// (ADR-292), the read `get_run_work` lists from:
//   - the run's own forge links, a GitLab merge request among them
//   - a ledger receipt matched by GitHub repository id and number
//   - a link frame matched by repository path and number, in any case
//   - a checkout's branch matched to a pull request's head branch, and a
//     branch another pull request merges into matching nothing
//   - each pull request's latest revision and its issue links
//   - another workspace's row for the same run never read, and a receipt or
//     link the store lacks counted
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
import { readRunPullRequests } from "./run-pulls";
import {
  linkRun,
  recordRevision,
  replaceIssueLinks,
  type Scope,
  upsertPullRequest,
} from "./store";

const enabled = Boolean(process.env.DATABASE_URL);
if (process.env.CI && !enabled)
  throw new Error("The forge run read test needs DATABASE_URL on CI.");

const sha = (c: string) => c.repeat(40);

function facts(
  over: Partial<ForgePullRequestFacts> &
    Pick<ForgePullRequestFacts, "repository" | "number">,
): ForgePullRequestFacts {
  return {
    host: "github.com",
    providerRepositoryId: "100",
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

const UNCONFIGURED: ForgePullRequestCapture = {
  diffStatus: "unconfigured",
  diffStore: null,
  diffKey: null,
  diffSha256: null,
  diffBytes: null,
  mergeBaseSha: null,
  files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
  filesChanged: 1,
  additions: 1,
  deletions: 0,
  complete: false,
  limitations: [],
};

describe.skipIf(!enabled)(
  "a run's pull requests from the forge store",
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
    const RUN = `arun_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const ids = new Map<string, string>();

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        const write = async (
          name: string,
          target: Scope,
          provider: "github" | "gitlab",
          pull: ForgePullRequestFacts,
          seenAt: string,
        ) => {
          const id = await upsertPullRequest(
            tx,
            target,
            provider,
            pull,
            new Date(seenAt),
          );
          ids.set(name, id);
          return id;
        };
        // The run opened this one; it closes one issue.
        const opened = await write(
          "opened",
          scope,
          "github",
          facts({ repository: "acme/api", number: 1, headRef: "feat/a" }),
          "2026-10-03T10:05:00Z",
        );
        await linkRun(tx, scope, opened, RUN, "opened");
        await recordRevision(
          tx,
          scope,
          opened,
          { headSha: sha("a"), baseSha: null },
          UNCONFIGURED,
          new Date("2026-10-03T10:05:00Z"),
        );
        await replaceIssueLinks(tx, scope, opened, [
          {
            nodeId: "I_7",
            repository: "acme/api",
            number: 7,
            url: "https://github.com/acme/api/issues/7",
            title: "Checkout fails on retry",
            state: "open",
          },
        ]);
        // A GitLab merge request the run is linked to.
        const merge = await write(
          "gitlab",
          scope,
          "gitlab",
          facts({
            host: "gitlab.com",
            providerRepositoryId: "991",
            repository: "acme/platform/web",
            number: 12,
            url: "https://gitlab.com/acme/platform/web/-/merge_requests/12",
          }),
          "2026-10-03T10:04:00Z",
        );
        await linkRun(tx, scope, merge, RUN, "recorded");
        // Named only by a ledger receipt: repository id 101, number 2.
        await write(
          "receipt",
          scope,
          "github",
          facts({ providerRepositoryId: "101", repository: "acme/api", number: 2 }),
          "2026-10-03T10:03:00Z",
        );
        // Named only by a link frame.
        await write(
          "link",
          scope,
          "github",
          facts({ providerRepositoryId: "102", repository: "acme/web", number: 3 }),
          "2026-10-03T10:02:00Z",
        );
        // Stacked on feat/a: a checkout on feat/d reaches it by branch.
        await write(
          "branch",
          scope,
          "github",
          facts({
            repository: "acme/api",
            number: 4,
            headRef: "feat/d",
            baseRef: "feat/a",
          }),
          "2026-10-03T10:01:00Z",
        );
        // Opened from a fork's main: a checkout on main must not reach it.
        await write(
          "fork",
          scope,
          "github",
          facts({ repository: "acme/api", number: 5, headRef: "main" }),
          "2026-10-03T10:00:00Z",
        );
        // The same run id in another workspace.
        const foreign = await write(
          "foreign",
          other,
          "github",
          facts({ repository: "acme/api", number: 1 }),
          "2026-10-03T10:06:00Z",
        );
        await linkRun(tx, other, foreign, RUN, "opened");
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        // Revisions and links cascade from their pull request.
        await tx
          .delete(schema.forgePullRequests)
          .where(eq(schema.forgePullRequests.orgId, scope.orgId));
      });
      await closeDatabase();
    });

    const read = () =>
      withSystemDb((tx) =>
        readRunPullRequests(tx, scope, {
          runId: RUN,
          receipts: [
            { providerRepositoryId: "101", number: 2 },
            { providerRepositoryId: "101", number: 99 },
          ],
          links: [
            { provider: "github", repository: "Acme/Web", number: 3 },
            { provider: "github", repository: "acme/web", number: 98 },
          ],
          branches: [
            { provider: "github", repository: "acme/api", branch: "feat/d" },
            { provider: "github", repository: "acme/api", branch: "feat/a" },
            { provider: "github", repository: "acme/api", branch: "main" },
          ],
        }),
      );

    it("reads the run's links, its receipts, its link frames, and its branches, newest first", async () => {
      const out = await read();
      expect(
        out.pullRequests.map(({ pull, sources }) => [pull.id, sources]),
      ).toEqual([
        [ids.get("opened"), ["run"]],
        [ids.get("gitlab"), ["run"]],
        [ids.get("receipt"), ["recorded"]],
        [ids.get("link"), ["recorded"]],
        [ids.get("branch"), ["branch"]],
      ]);
    });

    it("carries each one's latest revision and issue links", async () => {
      const out = await read();
      const opened = out.pullRequests.find(
        ({ pull }) => pull.id === ids.get("opened"),
      );
      expect(opened?.revision).toMatchObject({
        headSha: sha("a"),
        diffStatus: "unconfigured",
        files: UNCONFIGURED.files,
      });
      expect(opened?.issues.map((issue) => issue.issueNodeId)).toEqual(["I_7"]);
      const merge = out.pullRequests.find(
        ({ pull }) => pull.id === ids.get("gitlab"),
      );
      expect(merge?.pull).toMatchObject({
        provider: "gitlab",
        repository: "acme/platform/web",
      });
      expect(merge?.revision).toBeNull();
    });

    it("matches nothing on a branch another pull request merges into, and counts what the store lacks (negative)", async () => {
      const out = await read();
      expect(out.pullRequests.map(({ pull }) => pull.id)).not.toContain(
        ids.get("fork"),
      );
      expect(new Set(out.trunks)).toEqual(
        new Set(["github:acme/api:main", "github:acme/api:feat/a"]),
      );
      expect(out.unstored).toBe(2);
    });

    it("never reads another workspace's row for the same run (negative)", async () => {
      const out = await read();
      expect(out.pullRequests.map(({ pull }) => pull.id)).not.toContain(
        ids.get("foreign"),
      );
    });
  },
);
