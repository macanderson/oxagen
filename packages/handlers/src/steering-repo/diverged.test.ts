// diverged.test.ts: the history judge, the trailer parsers, and the GitHub and
// GitLab calls against a scripted server. The server answers by method and
// path with the JSON under ./fixtures/diverged/, which follows the shape of
// the real APIs, and the calls go through the real REST clients.
import { readFileSync } from "node:fs";
import { createGithubRest } from "@oxagen/github/provision";
import { createGitlabRest } from "@oxagen/gitlab/provision";
import { describe, expect, it } from "vitest";
import {
  type GithubHistoryTarget,
  type GitlabHistoryTarget,
  type HistoryCommit,
  type HistoryRange,
  assertGithubSteeringCommit,
  githubCloseRevert,
  githubDiverged,
  githubOpenRevert,
  githubPublished,
  gitlabCloseRevert,
  gitlabDiverged,
  gitlabOpenRevert,
  gitlabPublished,
  isRevertBranch,
  judgeHistory,
  REVERT_BRANCH_PREFIX,
  REVERT_TRAILER,
  revertBranch,
  revertMessage,
  revertTitle,
  revertTrailer,
  VERSION_TRAILER,
  versionTrailer,
} from "./diverged";
import type { Divergence, PublishedCommit } from "./health";

// ── Commits ──────────────────────────────────────────────────────────────────

/** The published commit, version 7. */
const P = "a1".repeat(20);
/** Oxagen's squash merge of version 8. */
const S1 = "b2".repeat(20);
/** A commit someone pushed past the branch rules. */
const X = "c3".repeat(20);
/** Oxagen's squash merge of version 9, and main in most tests. */
const S2 = "d4".repeat(20);
/** The revert commit. */
const R = "e5".repeat(20);
/** A main past the end of a compare page. */
const HEAD = "f0".repeat(20);
/** The commit before the published one. */
const OLD = "9a".repeat(20);
const TREE_P = "f6".repeat(20);
const TREE_OTHER = "07".repeat(20);

const BRANCH = "steering/revert-to-a1a1a1a-d4d4d4d";
const PUBLISHED: PublishedCommit = { sha: P, version: 7 };
const DIVERGENCE: Divergence = {
  reason: "main holds 1 commit that no pull request merged: c3c3c3c",
  main_sha: S2,
};

function mergeMessage(title: string, number: number, version: number): string {
  return `${title} (#${number})\n\nOxagen-Approved-By: dana\nOxagen-Checks: schema,lineage\n${VERSION_TRAILER}: ${version}`;
}

// ── Scripted server ──────────────────────────────────────────────────────────

interface Reply {
  status: number;
  body?: unknown;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function ok(body: unknown, status = 200): Reply {
  return { status, body };
}

function fail(status: number, message: string): Reply {
  return { status, body: { message } };
}

/**
 * A fake `fetch` keyed by `METHOD /path`. A list of replies answers in order
 * and repeats its last one. A request with no reply rejects, so a test fails
 * on any call it did not expect.
 */
function server(base: string, routes: Record<string, Reply | Reply[]>) {
  const queues = new Map<string, Reply[]>();
  for (const [key, reply] of Object.entries(routes))
    queues.set(key, Array.isArray(reply) ? [...reply] : [reply]);
  const calls: Call[] = [];
  const fetch = (url: string, init: { method: string; body?: string }) => {
    const path = url.slice(base.length);
    const key = `${init.method} ${path}`;
    calls.push({
      method: init.method,
      path,
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    });
    const queue = queues.get(key);
    const reply =
      queue !== undefined && queue.length > 1 ? queue.shift() : queue?.[0];
    if (reply === undefined)
      return Promise.reject(new Error(`No reply scripted for ${key}`));
    const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
    return Promise.resolve({
      status: reply.status,
      text: () => Promise.resolve(text),
    });
  };
  return {
    fetch,
    calls,
    sent: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key),
    writes: () => calls.filter((c) => c.method !== "GET"),
  };
}

function fixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/diverged/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as T;
}

// ── History judge ────────────────────────────────────────────────────────────

function squash(sha: string, parent: string, version: number): HistoryCommit {
  return {
    sha,
    parents: [parent],
    message: mergeMessage("Change a rule", 50, version),
  };
}

function range(
  commits: HistoryCommit[],
  over: Partial<HistoryRange> = {},
): HistoryRange {
  return {
    status: "ahead",
    commits,
    truncated: false,
    main_sha: S2,
    restored_at: -1,
    ...over,
  };
}

const FOREIGN: HistoryCommit = {
  sha: X,
  parents: [S1],
  message: "Edit the release notes rule by hand",
};

describe("judgeHistory", () => {
  it("passes a main that is the published commit", () => {
    expect(judgeHistory(PUBLISHED, range([], { status: "identical" }))).toBeNull();
  });

  it("flags a main that is behind the published commit", () => {
    expect(judgeHistory(PUBLISHED, range([], { status: "behind" }))).toEqual({
      reason: "main no longer contains the published commit a1a1a1a",
      main_sha: S2,
    });
  });

  it("flags a main whose history no longer holds the published commit", () => {
    expect(
      judgeHistory(PUBLISHED, range([FOREIGN], { status: "diverged", main_sha: X })),
    ).toEqual({
      reason: "main no longer contains the published commit a1a1a1a",
      main_sha: X,
    });
  });

  it("flags more commits than the host listed", () => {
    expect(
      judgeHistory(PUBLISHED, range([squash(S1, P, 8)], { truncated: true })),
    ).toEqual({
      reason:
        "main holds more commits since the published commit a1a1a1a than Oxagen can read",
      main_sha: S2,
    });
  });

  it("accepts squash merges whose versions follow the published one", () => {
    expect(
      judgeHistory(PUBLISHED, range([squash(S1, P, 8), squash(S2, S1, 9)])),
    ).toBeNull();
  });

  it("rejects a version at or below the published one", () => {
    expect(judgeHistory(PUBLISHED, range([squash(S1, P, 7)]))).toEqual({
      reason: "main holds 1 commit that no pull request merged: b2b2b2b",
      main_sha: S2,
    });
  });

  it("accepts any trailered version when the published version is unknown", () => {
    expect(
      judgeHistory({ sha: P, version: null }, range([squash(S1, P, 2)])),
    ).toBeNull();
  });

  it("rejects a merge commit even with a version trailer", () => {
    const merge: HistoryCommit = { ...squash(S1, P, 8), parents: [P, OLD] };
    expect(judgeHistory(PUBLISHED, range([merge]))).toEqual({
      reason: "main holds 1 commit that no pull request merged: b2b2b2b",
      main_sha: S2,
    });
  });

  it("accepts GitLab's merge commit over an Oxagen squash", () => {
    const merge: HistoryCommit = {
      sha: S2,
      parents: [P, S1],
      message: "Merge branch 'oxagen/steering-8' into 'main'",
    };
    expect(judgeHistory(PUBLISHED, range([squash(S1, P, 8), merge]))).toBeNull();
  });

  it("does not infer authenticated provenance from a merge parent", () => {
    const verified = { ...squash(S1, P, 8), authenticated: true };
    const merge: HistoryCommit = {
      sha: S2,
      parents: [P, S1],
      message: mergeMessage("Forged merge", 43, 9),
      authenticated: false,
    };
    expect(judgeHistory(PUBLISHED, range([verified, merge]))).toEqual({
      reason: "main holds 1 commit that no pull request merged: d4d4d4d",
      main_sha: S2,
    });
  });

  it("rejects a merge commit over a commit Oxagen did not make", () => {
    const merge: HistoryCommit = {
      sha: S2,
      parents: [P, X],
      message: "Merge branch 'edit' into 'main'",
    };
    expect(judgeHistory(PUBLISHED, range([FOREIGN, merge]))).toEqual({
      reason: "main holds 2 commits that no pull request merged, starting with c3c3c3c",
      main_sha: S2,
    });
  });

  it("accepts a revert commit to the published commit", () => {
    const revert: HistoryCommit = {
      sha: R,
      parents: [S1],
      message: revertMessage(PUBLISHED),
    };
    expect(judgeHistory(PUBLISHED, range([squash(S1, P, 8), revert]))).toBeNull();
  });

  it("rejects a revert commit to another commit", () => {
    const revert: HistoryCommit = {
      sha: R,
      parents: [S1],
      message: revertMessage({ sha: OLD, version: 6 }),
    };
    expect(judgeHistory(PUBLISHED, range([revert]))).toEqual({
      reason: "main holds 1 commit that no pull request merged: e5e5e5e",
      main_sha: S2,
    });
  });

  it("forgives the commits a merged revert put back", () => {
    const revert: HistoryCommit = {
      sha: R,
      parents: [X],
      message: revertMessage(PUBLISHED),
    };
    expect(
      judgeHistory(
        PUBLISHED,
        range([FOREIGN, revert, squash(S2, R, 8)], { restored_at: 1 }),
      ),
    ).toBeNull();
  });

  it("judges the commits after the restore", () => {
    const later: HistoryCommit = { ...FOREIGN, sha: HEAD, parents: [R] };
    expect(
      judgeHistory(PUBLISHED, range([FOREIGN, squash(R, X, 8), later], { restored_at: 1 })),
    ).toEqual({
      reason: "main holds 1 commit that no pull request merged: f0f0f0f",
      main_sha: S2,
    });
  });

  it("names one foreign commit", () => {
    expect(
      judgeHistory(PUBLISHED, range([squash(S1, P, 8), FOREIGN, squash(S2, X, 9)])),
    ).toEqual(DIVERGENCE);
  });

  it("counts several foreign commits and names the oldest", () => {
    const second: HistoryCommit = { ...FOREIGN, sha: HEAD, parents: [X] };
    expect(
      judgeHistory(PUBLISHED, range([squash(S1, P, 8), FOREIGN, second])),
    ).toEqual({
      reason: "main holds 2 commits that no pull request merged, starting with c3c3c3c",
      main_sha: S2,
    });
  });
});

// ── Names and trailers ───────────────────────────────────────────────────────

describe("trailers", () => {
  it("reads the version from a squash merge message", () => {
    expect(versionTrailer(mergeMessage("Add a rule", 42, 9))).toBe(9);
  });

  it("reads a version line that ends with spaces or a carriage return", () => {
    expect(versionTrailer(`Title\r\n\r\n${VERSION_TRAILER}: 12 \r\n`)).toBe(12);
  });

  it("reads no version from a message without the trailer", () => {
    expect(versionTrailer("Edit the release notes rule by hand")).toBeNull();
  });

  it("reads no version from a trailer inside a sentence", () => {
    expect(versionTrailer(`Copy the ${VERSION_TRAILER}: 3 line`)).toBeNull();
  });

  it("reads no version across a line break", () => {
    expect(versionTrailer(`Title\n\n${VERSION_TRAILER}:\n5`)).toBeNull();
  });

  it("reads no version too large to hold exactly", () => {
    expect(versionTrailer(`${VERSION_TRAILER}: 99999999999999999999`)).toBeNull();
  });

  it("reads the published sha from a revert message", () => {
    expect(revertTrailer(revertMessage(PUBLISHED))).toBe(P);
  });

  it("reads no revert trailer with a short or uppercase sha", () => {
    expect(revertTrailer(`${REVERT_TRAILER}: a1a1a1a`)).toBeNull();
    expect(revertTrailer(`${REVERT_TRAILER}: ${P.toUpperCase()}`)).toBeNull();
    expect(revertTrailer("Revert main")).toBeNull();
  });
});

describe("revert names", () => {
  it("names the branch after the published commit and main", () => {
    expect(revertBranch(P, S2)).toBe(BRANCH);
    expect(BRANCH.startsWith(REVERT_BRANCH_PREFIX)).toBe(true);
  });

  it("recognizes a revert branch by name or by full ref", () => {
    expect(isRevertBranch(BRANCH)).toBe(true);
    expect(isRevertBranch(`refs/heads/${BRANCH}`)).toBe(true);
  });

  it("recognizes no other branch", () => {
    expect(isRevertBranch(REVERT_BRANCH_PREFIX)).toBe(false);
    expect(isRevertBranch("main")).toBe(false);
    expect(isRevertBranch("steering/add-release-notes")).toBe(false);
    expect(isRevertBranch(`refs/tags/${BRANCH}`)).toBe(false);
  });

  it("titles the revert by version", () => {
    expect(revertTitle(7)).toBe("Revert main to published version 7");
    expect(revertTitle(null)).toBe("Revert main to the last published version");
  });

  it("writes the title and the revert trailer", () => {
    expect(revertMessage(PUBLISHED)).toBe(
      `Revert main to published version 7\n\n${REVERT_TRAILER}: ${P}`,
    );
    expect(revertMessage({ sha: P, version: null })).toBe(
      `Revert main to the last published version\n\n${REVERT_TRAILER}: ${P}`,
    );
  });
});

// ── GitHub ───────────────────────────────────────────────────────────────────

const GH = "/repos/acme/steering";

/** The test clock: 2026-10-02T21:02:45Z, when the live test's merge landed. */
const NOW = Date.parse("2026-10-02T21:02:45Z");

function github(routes: Record<string, Reply | Reply[]>) {
  const s = server("https://api.github.com", routes);
  const waits: number[] = [];
  const target: GithubHistoryTarget = {
    rest: createGithubRest({ token: "ghs_test", fetch: s.fetch }),
    repo: { owner: "acme", name: "steering" },
    app: { symbol: "oxagen-steering", id: 1234, slug: "oxagen-steering" },
    now: () => NOW,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
  return { ...s, target, waits };
}

/** A `git/commits` reply for `sha`, committed `secondsAgo` before NOW. */
function committed(sha: string, secondsAgo: number): Reply {
  return ok({
    sha,
    tree: { sha: "t1" },
    parents: [{ sha: P }],
    committer: { date: new Date(NOW - secondsAgo * 1000).toISOString() },
  });
}

interface GithubDeploymentFixture {
  payload: unknown;
  description: string | null;
}

interface GithubCompareFixture {
  status: string;
  total_commits: number;
  commits: {
    sha: string;
    parents: { sha: string }[];
    commit: { message: string; tree: { sha: string } };
  }[];
}

interface GithubPullFixture {
  number: number;
  state: string;
  head: { ref: string };
  base: { ref: string };
}

const DEPLOYMENTS = `GET ${GH}/deployments?environment=steering&per_page=30`;
const COMPARE = `GET ${GH}/compare/${P}...main?per_page=100`;
const MAIN_BRANCH = `GET ${GH}/branches/main`;
const REF = `GET ${GH}/git/ref/heads/${BRANCH}`;
const PULLS = `GET ${GH}/pulls?state=open&head=acme%3Asteering%2Frevert-to-a1a1a1a-d4d4d4d`;
const CHECK_RUNS = `GET ${GH}/commits/${R}/check-runs?check_name=Oxagen%20steering&app_id=1234`;

function branchReply(sha: string): Reply {
  return ok({ name: "main", commit: { sha }, protected: true });
}

function authenticatedPull(sha: string, number: number) {
  return {
    number,
    merged: true,
    merge_commit_sha: sha,
    base: { ref: "main", repo: { id: 812, full_name: "acme/steering" } },
    merged_by: { type: "Bot", login: "oxagen-steering[bot]" },
  };
}

function authenticatedRoutes(...commits: string[]): Record<string, Reply> {
  return Object.fromEntries(
    commits.flatMap((sha, index) => {
      const number = 42 + index;
      return [
        [`GET ${GH}/commits/${sha}/pulls?per_page=100`, ok([{ number }])],
        [`GET ${GH}/pulls/${number}`, ok(authenticatedPull(sha, number))],
      ];
    }),
  );
}

function singleGithubCommit(message: string): GithubCompareFixture {
  const compare = fixture<GithubCompareFixture>("github-compare-ahead");
  compare.commits = compare.commits.slice(0, 1);
  compare.commits[0]!.commit.message = message;
  compare.total_commits = 1;
  return compare;
}

describe("githubPublished", () => {
  it("takes the app's newest deployment and reads a string payload", async () => {
    const gh = github({ [DEPLOYMENTS]: ok(fixture("github-deployments")) });
    await expect(githubPublished(gh.target)).resolves.toEqual({ sha: P, version: 7 });
  });

  it("reads the version from the description when the payload has none", async () => {
    const deployments = fixture<GithubDeploymentFixture[]>("github-deployments");
    deployments[1]!.payload = {};
    deployments[1]!.description = "Steering version 7 from #41";
    const gh = github({ [DEPLOYMENTS]: ok(deployments) });
    await expect(githubPublished(gh.target)).resolves.toEqual({ sha: P, version: 7 });
  });

  it("reports an unknown version when neither names one", async () => {
    const deployments = fixture<GithubDeploymentFixture[]>("github-deployments");
    deployments[1]!.payload = "not json";
    deployments[1]!.description = null;
    const gh = github({ [DEPLOYMENTS]: ok(deployments) });
    await expect(githubPublished(gh.target)).resolves.toEqual({ sha: P, version: null });
  });

  it("anchors on the app's bot user when GitHub names no app (#4949)", async () => {
    const gh = github({
      [DEPLOYMENTS]: ok([
        {
          sha: P,
          performed_via_github_app: null,
          creator: { login: "oxagen-steering[bot]", type: "Bot" },
        },
      ]),
    });
    await expect(githubPublished(gh.target)).resolves.toEqual({
      sha: P,
      version: null,
    });
  });

  it("refuses a deployment by a person or another bot when GitHub names no app (negative)", async () => {
    for (const creator of [
      { login: "oxagen-steering[bot]", type: "User" },
      { login: "someone-else[bot]", type: "Bot" },
      null,
    ]) {
      const gh = github({
        [DEPLOYMENTS]: ok([{ sha: P, performed_via_github_app: null, creator }]),
      });
      await expect(githubPublished(gh.target)).resolves.toBeNull();
    }
  });

  it("returns null when the app recorded no deployment", async () => {
    const deployments = fixture<GithubDeploymentFixture[]>("github-deployments");
    const gh = github({ [DEPLOYMENTS]: ok(deployments.slice(0, 1)) });
    await expect(githubPublished(gh.target)).resolves.toBeNull();
  });
});

describe("githubDiverged", () => {
  it("passes a main ahead by authenticated app merges", async () => {
    const gh = github({
      [COMPARE]: ok(fixture("github-compare-ahead")),
      ...authenticatedRoutes(S1, S2),
    });
    await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toBeNull();
    expect(gh.calls).toHaveLength(5);
  });

  it("names a foreign commit and takes main from the compare", async () => {
    const gh = github({
      [COMPARE]: ok(fixture("github-compare-foreign")),
      ...authenticatedRoutes(S1, S2),
      [`GET ${GH}/commits/${X}/pulls?per_page=100`]: ok([]),
    });
    await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toEqual(DIVERGENCE);
    expect(gh.sent(MAIN_BRANCH)).toHaveLength(0);
  });

  it("reads main from the branch when the compare cannot find the published commit", async () => {
    const gh = github({
      [COMPARE]: fail(404, "Not Found"),
      [MAIN_BRANCH]: branchReply(S2),
    });
    await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toEqual({
      reason: "main no longer contains the published commit a1a1a1a",
      main_sha: S2,
    });
  });

  it("reads main from the branch when the compare holds one page of many", async () => {
    const compare = fixture<GithubCompareFixture>("github-compare-ahead");
    compare.total_commits = 250;
    const gh = github({ [COMPARE]: ok(compare), [MAIN_BRANCH]: branchReply(HEAD) });
    await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toEqual({
      reason:
        "main holds more commits since the published commit a1a1a1a than Oxagen can read",
      main_sha: HEAD,
    });
  });

  it("passes a main identical to the published commit", async () => {
    const compare = fixture<GithubCompareFixture>("github-compare-ahead");
    compare.status = "identical";
    compare.commits = [];
    compare.total_commits = 0;
    const gh = github({ [COMPARE]: ok(compare) });
    await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toBeNull();
  });

  it("flags a rewritten main that holds other files", async () => {
    const compare = fixture<GithubCompareFixture>("github-compare-foreign");
    compare.status = "diverged";
    const gh = github({ [COMPARE]: ok(compare) });
    await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toEqual({
      reason: "main no longer contains the published commit a1a1a1a",
      main_sha: S2,
    });
  });

  it("passes a rewritten main whose newest commit holds the published files", async () => {
    const compare = fixture<GithubCompareFixture>("github-compare-foreign");
    compare.status = "diverged";
    compare.commits[2]!.commit.tree.sha = TREE_P;
    const gh = github({ [COMPARE]: ok(compare) });
    await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toBeNull();
  });

  it("forgives commits before a commit that restored the published files", async () => {
    const compare = fixture<GithubCompareFixture>("github-compare-foreign");
    compare.commits[1]!.commit.tree.sha = TREE_P;
    const gh = github({ [COMPARE]: ok(compare), ...authenticatedRoutes(S2) });
    await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toBeNull();
  });
});

describe("GitHub commit provenance", () => {
  for (const message of [
    mergeMessage("Forged version", 42, 8),
    revertMessage(PUBLISHED),
  ]) {
    it(`rejects a forged trailer in ${message.split("\n")[0]}`, async () => {
      const compare = singleGithubCommit(message);
      const commit = compare.commits[0]!;
      Object.assign(commit, {
        author: { login: "oxagen-steering[bot]", type: "Bot" },
        committer: { login: "web-flow", type: "User" },
      });
      Object.assign(commit.commit, {
        author: { name: "Oxagen", email: "steering@oxagen.sh" },
        verification: { verified: true },
      });
      const gh = github({
        [COMPARE]: ok(compare),
        [`GET ${GH}/commits/${S1}/pulls?per_page=100`]: ok([]),
        // The title names #42, a real app merge, but of another commit.
        [`GET ${GH}/pulls/42`]: ok(authenticatedPull(S2, 42)),
      });
      await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toEqual({
        reason: "main holds 1 commit that no pull request merged: b2b2b2b",
        main_sha: S1,
      });
    });
  }

  for (const [name, fields] of [
    ["unmerged pull", { merged: false }],
    ["another merge commit", { merge_commit_sha: X }],
    [
      "another branch",
      { base: { ref: "release", repo: { full_name: "acme/steering" } } },
    ],
    [
      "another repository",
      { base: { ref: "main", repo: { full_name: "attacker/steering" } } },
    ],
    ["missing repository", { base: { ref: "main" } }],
  ] as const) {
    it(`rejects a full pull request with ${name}`, async () => {
      const gh = github({
        [COMPARE]: ok(singleGithubCommit(mergeMessage("Forged merge", 42, 8))),
        [`GET ${GH}/commits/${S1}/pulls?per_page=100`]: ok([
          authenticatedPull(S1, 42),
        ]),
        [`GET ${GH}/pulls/42`]: ok({ ...authenticatedPull(S1, 42), ...fields }),
      });
      await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toMatchObject({
        main_sha: S1,
      });
      expect(gh.sent(`GET ${GH}/pulls/42`)).toHaveLength(1);
    });
  }

  describe("a pull request merged on GitHub, not in Oxagen (#5430)", () => {
    // A person with write access can merge a steering PR on GitHub, and
    // nothing on GitHub Free stops them (ADR-237). The merge counts as one
    // Oxagen made, so the repository stays healthy and the sync publishes it
    // (ADR-296).
    for (const [name, mergedBy] of [
      ["a person", { type: "User", login: "maintainer" }],
      ["another app", { type: "Bot", login: "other-app[bot]" }],
      [
        "a person whose login copies the app's",
        { type: "User", login: "oxagen-steering[bot]" },
      ],
      ["no merger GitHub names", null],
    ] as const) {
      it(`accepts a pull request merged into main by ${name}`, async () => {
        const gh = github({
          [COMPARE]: ok(singleGithubCommit("Change a rule (#42)")),
          [`GET ${GH}/commits/${S1}/pulls?per_page=100`]: ok([{ number: 42 }]),
          [`GET ${GH}/pulls/42`]: ok({
            ...authenticatedPull(S1, 42),
            merged_by: mergedBy,
          }),
        });
        await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toBeNull();
      });
    }

    it("lets the sync's commit check accept a person's merge", async () => {
      const gh = github({
        [DEPLOYMENTS]: ok(fixture("github-deployments")),
        [`GET ${GH}/compare/${P}...${S1}?per_page=100`]: ok(
          singleGithubCommit("Change a rule (#42)"),
        ),
        [`GET ${GH}/commits/${S1}/pulls?per_page=100`]: ok([{ number: 42 }]),
        [`GET ${GH}/pulls/42`]: ok({
          ...authenticatedPull(S1, 42),
          merged_by: { type: "User", login: "maintainer" },
        }),
      });
      await expect(assertGithubSteeringCommit(gh.target, S1)).resolves.toBeUndefined();
    });

    it("still flags a commit pushed to main with no pull request", async () => {
      const gh = github({
        [COMPARE]: ok(singleGithubCommit("Edit a rule on main")),
        [`GET ${GH}/commits/${S1}/pulls?per_page=100`]: ok([]),
      });
      await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toEqual({
        reason: "main holds 1 commit that no pull request merged: b2b2b2b",
        main_sha: S1,
      });
    });

    it("still flags a push whose title names a pull request a person merged as another commit", async () => {
      const gh = github({
        [COMPARE]: ok(singleGithubCommit("Edit a rule on main (#42)")),
        [`GET ${GH}/commits/${S1}/pulls?per_page=100`]: ok([]),
        [`GET ${GH}/pulls/42`]: ok({
          ...authenticatedPull(S2, 42),
          merged_by: { type: "User", login: "maintainer" },
        }),
      });
      await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toEqual({
        reason: "main holds 1 commit that no pull request merged: b2b2b2b",
        main_sha: S1,
      });
    });
  });

  it("accepts an authenticated merge without a version trailer", async () => {
    const gh = github({
      [COMPARE]: ok(singleGithubCommit("Change a rule")),
      ...authenticatedRoutes(S1),
    });
    await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toBeNull();
  });

  describe("before GitHub lists the merge's pull request (#5157)", () => {
    // GitHub fills in a commit's list of pull requests a few seconds after
    // the merge. Live run 37039713059 read it about a second after Oxagen
    // merged, found none, and refused Oxagen's own merge commit.
    const OWN_MERGE = mergeMessage("steering: publish live-test.merge", 42, 8);
    const EXACT = `GET ${GH}/compare/${P}...${S1}?per_page=100`;
    const LIST = `GET ${GH}/commits/${S1}/pulls?per_page=100`;
    const PULL = `GET ${GH}/pulls/42`;

    it("accepts Oxagen's merge from the pull request its title names", async () => {
      const gh = github({
        [EXACT]: ok(singleGithubCommit(OWN_MERGE)),
        [LIST]: ok([]),
        [PULL]: ok(authenticatedPull(S1, 42)),
      });
      await expect(githubDiverged(gh.target, PUBLISHED, S1)).resolves.toBeNull();
      expect(gh.sent(LIST)).toHaveLength(1);
      expect(gh.sent(PULL)).toHaveLength(1);
    });

    it("lets the check after the merge accept the merge commit", async () => {
      const gh = github({
        [DEPLOYMENTS]: ok(fixture("github-deployments")),
        [EXACT]: ok(singleGithubCommit(OWN_MERGE)),
        [LIST]: ok([]),
        [PULL]: ok(authenticatedPull(S1, 42)),
      });
      await expect(assertGithubSteeringCommit(gh.target, S1)).resolves.toBeUndefined();
    });

    it("keeps the health read a push starts from reading main as diverged", async () => {
      const gh = github({
        [COMPARE]: ok(fixture("github-compare-ahead")),
        [LIST]: ok([]),
        [`GET ${GH}/commits/${S2}/pulls?per_page=100`]: ok([]),
        [PULL]: ok(authenticatedPull(S1, 42)),
        [`GET ${GH}/pulls/43`]: ok(authenticatedPull(S2, 43)),
      });
      await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toBeNull();
    });

    it("accepts a title that names a pull request a person merged (#5430)", async () => {
      const gh = github({
        [EXACT]: ok(singleGithubCommit(OWN_MERGE)),
        [LIST]: ok([]),
        [PULL]: ok({
          ...authenticatedPull(S1, 42),
          merged_by: { type: "User", login: "maintainer" },
        }),
      });
      await expect(githubDiverged(gh.target, PUBLISHED, S1)).resolves.toBeNull();
    });

    it("reads a number only from the end of the title", async () => {
      const gh = github({
        [EXACT]: ok(singleGithubCommit("Fix (#42) by hand\n\nSee also (#43)")),
        [LIST]: ok([]),
      });
      await expect(githubDiverged(gh.target, PUBLISHED, S1)).resolves.toMatchObject({
        main_sha: S1,
      });
      expect(gh.calls.map((c) => c.path)).toEqual([
        `${GH}/compare/${P}...${S1}?per_page=100`,
        `${GH}/commits/${S1}/pulls?per_page=100`,
      ]);
    });
  });

  it("matches the repository name without case sensitivity", async () => {
    const gh = github({
      [COMPARE]: ok(singleGithubCommit("Change a rule")),
      ...authenticatedRoutes(S1),
      [`GET ${GH}/pulls/42`]: ok({
        ...authenticatedPull(S1, 42),
        base: { ref: "main", repo: { full_name: "ACME/Steering" } },
      }),
    });
    await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toBeNull();
  });

  it("rejects an authenticated repository ID mismatch despite a matching name", async () => {
    const gh = github({
      [COMPARE]: ok(singleGithubCommit("Change a rule")),
      ...authenticatedRoutes(S1),
    });
    gh.target.repo.id = 999;
    await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toMatchObject({
      main_sha: S1,
    });
  });

  it("rejects a missing repository ID when the target pins its ID", async () => {
    const gh = github({
      [COMPARE]: ok(singleGithubCommit("Change a rule")),
      ...authenticatedRoutes(S1),
      [`GET ${GH}/pulls/42`]: ok({
        ...authenticatedPull(S1, 42),
        base: { ref: "main", repo: { full_name: "acme/steering" } },
      }),
    });
    gh.target.repo.id = 812;
    await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toMatchObject({
      main_sha: S1,
    });
  });

  it("does not let an app merge launder an unauthorized ancestor", async () => {
    const gh = github({
      [COMPARE]: ok(fixture("github-compare-ahead")),
      ...authenticatedRoutes(S2),
      [`GET ${GH}/commits/${S1}/pulls?per_page=100`]: ok([]),
    });
    await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toEqual({
      reason: "main holds 1 commit that no pull request merged: b2b2b2b",
      main_sha: S2,
    });
    expect(gh.sent(`GET ${GH}/commits/${S1}/pulls?per_page=100`)).toHaveLength(1);
    expect(gh.sent(`GET ${GH}/commits/${S2}/pulls?per_page=100`)).toHaveLength(1);
  });

  it("accepts a restored tree without trusting a revert trailer", async () => {
    const compare = singleGithubCommit("Restore the published files");
    compare.commits[0]!.commit.tree.sha = TREE_P;
    const gh = github({ [COMPARE]: ok(compare) });
    await expect(githubDiverged(gh.target, PUBLISHED)).resolves.toBeNull();
    expect(gh.calls).toHaveLength(1);
  });

  it("compares the exact candidate and authenticates its configured base branch", async () => {
    const exact = `GET ${GH}/compare/${P}...${S1}?per_page=100`;
    const gh = github({
      [exact]: ok(singleGithubCommit("Change a rule")),
      ...authenticatedRoutes(S1),
      [`GET ${GH}/pulls/42`]: ok({
        ...authenticatedPull(S1, 42),
        base: { ref: "release", repo: { full_name: "acme/steering" } },
      }),
    });
    gh.target.defaultBranch = "release";
    await expect(githubDiverged(gh.target, PUBLISHED, S1)).resolves.toBeNull();
    expect(gh.sent(exact)).toHaveLength(1);
    expect(gh.sent(MAIN_BRANCH)).toHaveLength(0);
  });

  it("rejects a mutable ref passed as an exact candidate", async () => {
    const gh = github({});
    await expect(githubDiverged(gh.target, PUBLISHED, "main")).rejects.toThrow(
      /full commit SHA/,
    );
    expect(gh.calls).toHaveLength(0);
  });

  it("fails closed on truncated history for an exact candidate", async () => {
    const compare = fixture<GithubCompareFixture>("github-compare-ahead");
    compare.total_commits = 250;
    const gh = github({
      [`GET ${GH}/compare/${P}...${HEAD}?per_page=100`]: ok(compare),
    });
    await expect(githubDiverged(gh.target, PUBLISHED, HEAD)).resolves.toMatchObject({
      reason: expect.stringContaining("more commits"),
      main_sha: HEAD,
    });
    expect(gh.calls).toHaveLength(1);
  });

  it("fails a missing exact candidate without reading mutable main", async () => {
    const gh = github({
      [`GET ${GH}/compare/${P}...${X}?per_page=100`]: fail(404, "Not Found"),
    });
    await expect(githubDiverged(gh.target, PUBLISHED, X)).resolves.toMatchObject({
      main_sha: X,
    });
    expect(gh.sent(MAIN_BRANCH)).toHaveLength(0);
  });

  for (const failurePath of [
    `GET ${GH}/commits/${S1}/pulls?per_page=100`,
    `GET ${GH}/pulls/42`,
  ]) {
    it(`propagates failure from ${failurePath}`, async () => {
      const gh = github({
        [COMPARE]: ok(singleGithubCommit("Change a rule")),
        ...authenticatedRoutes(S1),
        [failurePath]: fail(403, "Permission denied"),
      });
      await expect(githubDiverged(gh.target, PUBLISHED)).rejects.toThrow(
        /Permission denied/,
      );
    });
  }
});

describe("assertGithubSteeringCommit", () => {
  it("authenticates the deployment anchor and the exact candidate", async () => {
    const gh = github({
      [DEPLOYMENTS]: ok(fixture("github-deployments")),
      [`GET ${GH}/compare/${P}...${S1}?per_page=100`]: ok(
        singleGithubCommit("Change a rule"),
      ),
      ...authenticatedRoutes(S1),
    });
    await expect(assertGithubSteeringCommit(gh.target, S1)).resolves.toBeUndefined();
    expect(gh.sent(MAIN_BRANCH)).toHaveLength(0);
  });

  it("refuses a commit as a conflict when no authenticated deployment exists", async () => {
    const gh = github({ [DEPLOYMENTS]: ok([]) });
    await expect(assertGithubSteeringCommit(gh.target, X)).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_publication_missing",
    });
    expect(gh.calls).toHaveLength(1);
  });

  it("refuses a candidate with forged provenance as a conflict, not a server error (#5157)", async () => {
    const gh = github({
      [DEPLOYMENTS]: ok(fixture("github-deployments")),
      [`GET ${GH}/compare/${P}...${S1}?per_page=100`]: ok(
        singleGithubCommit(mergeMessage("Forged", 42, 8)),
      ),
      [`GET ${GH}/commits/${S1}/pulls?per_page=100`]: ok([]),
      [`GET ${GH}/pulls/42`]: ok(authenticatedPull(S2, 42)),
      [`GET ${GH}/git/commits/${S1}`]: committed(S1, 3600),
    });
    await expect(assertGithubSteeringCommit(gh.target, S1)).rejects.toMatchObject({
      name: "HandlerError",
      code: "conflict",
      reason: "steering_commit_unproven",
      message: expect.stringContaining(
        "main holds 1 commit that no pull request merged: b2b2b2b",
      ),
    });
    // An hour-old commit is refused on the first read: no wait, one compare.
    expect(gh.waits).toEqual([]);
    expect(gh.sent(`GET ${GH}/compare/${P}...${S1}?per_page=100`)).toHaveLength(1);
  });

  it("accepts its own merge when GitHub proves it a few seconds late (#5157)", async () => {
    const gh = github({
      [DEPLOYMENTS]: ok(fixture("github-deployments")),
      [`GET ${GH}/compare/${P}...${S1}?per_page=100`]: ok(
        singleGithubCommit(mergeMessage("Change a rule", 42, 8)),
      ),
      [`GET ${GH}/git/commits/${S1}`]: committed(S1, 2),
      // GitHub lists no pull request, then still shows #42 unmerged, then
      // proves the merge on the third check.
      [`GET ${GH}/commits/${S1}/pulls?per_page=100`]: [ok([]), ok([]), ok([{ number: 42 }])],
      [`GET ${GH}/pulls/42`]: [
        ok({ ...authenticatedPull(S1, 42), merged: false, merge_commit_sha: null }),
        ok({ ...authenticatedPull(S1, 42), merged: false, merge_commit_sha: null }),
        ok(authenticatedPull(S1, 42)),
      ],
    });
    await expect(assertGithubSteeringCommit(gh.target, S1)).resolves.toBeUndefined();
    expect(gh.waits).toEqual([1_500, 1_500]);
    expect(gh.sent(`GET ${GH}/compare/${P}...${S1}?per_page=100`)).toHaveLength(3);
  });

  it("refuses a merge made moments ago that GitHub never proves (negative)", async () => {
    const gh = github({
      [DEPLOYMENTS]: ok(fixture("github-deployments")),
      [`GET ${GH}/compare/${P}...${S1}?per_page=100`]: ok(
        singleGithubCommit(mergeMessage("Forged", 42, 8)),
      ),
      [`GET ${GH}/git/commits/${S1}`]: committed(S1, 2),
      [`GET ${GH}/commits/${S1}/pulls?per_page=100`]: ok([]),
      [`GET ${GH}/pulls/42`]: ok(authenticatedPull(S2, 42)),
    });
    await expect(assertGithubSteeringCommit(gh.target, S1)).rejects.toMatchObject({
      reason: "steering_commit_unproven",
    });
    // Six checks, 1.5 seconds apart, then the refusal.
    expect(gh.waits).toEqual(Array.from({ length: 5 }, () => 1_500));
    expect(gh.sent(`GET ${GH}/compare/${P}...${S1}?per_page=100`)).toHaveLength(6);
  });

  it("refuses at once when GitHub cannot date the commit (negative)", async () => {
    const gh = github({
      [DEPLOYMENTS]: ok(fixture("github-deployments")),
      [`GET ${GH}/compare/${P}...${S1}?per_page=100`]: ok(
        singleGithubCommit(mergeMessage("Forged", 42, 8)),
      ),
      [`GET ${GH}/git/commits/${S1}`]: ok({ sha: S1, tree: { sha: "t1" }, parents: [] }),
      [`GET ${GH}/commits/${S1}/pulls?per_page=100`]: ok([]),
      [`GET ${GH}/pulls/42`]: ok(authenticatedPull(S2, 42)),
    });
    await expect(assertGithubSteeringCommit(gh.target, S1)).rejects.toMatchObject({
      reason: "steering_commit_unproven",
    });
    expect(gh.waits).toEqual([]);
  });

  it("propagates deployment lookup errors", async () => {
    const gh = github({ [DEPLOYMENTS]: fail(502, "Deployment lookup failed") });
    await expect(assertGithubSteeringCommit(gh.target, S1)).rejects.toThrow(
      /Deployment lookup failed/,
    );
  });

  it("refuses deployments from another app despite its matching slug", async () => {
    const gh = github({
      [DEPLOYMENTS]: ok([
        {
          sha: P,
          performed_via_github_app: { id: 999, slug: "oxagen-steering" },
        },
      ]),
    });
    await expect(assertGithubSteeringCommit(gh.target, S1)).rejects.toMatchObject({
      reason: "steering_publication_missing",
    });
  });

  it("fails closed when the deployment history holds no app anchor", async () => {
    const gh = github({
      [DEPLOYMENTS]: ok(
        Array.from({ length: 30 }, () => ({
          sha: X,
          performed_via_github_app: null,
        })),
      ),
      [`${DEPLOYMENTS}&page=2`]: ok([]),
    });
    await expect(assertGithubSteeringCommit(gh.target, S1)).rejects.toMatchObject({
      reason: "steering_publication_missing",
    });
  });
});

describe("published deployment paging (#4653)", () => {
  const FOREIGN_PAGE = (count: number) =>
    Array.from({ length: count }, () => ({
      sha: X,
      performed_via_github_app: { id: 77, slug: "deploy-bot" },
    }));

  it("finds the app's deployment on GitHub's second page", async () => {
    const gh = github({
      [DEPLOYMENTS]: ok(FOREIGN_PAGE(30)),
      [`${DEPLOYMENTS}&page=2`]: ok(fixture("github-deployments")),
    });
    await expect(githubPublished(gh.target)).resolves.toEqual({ sha: P, version: 7 });
    expect(gh.calls).toHaveLength(2);
  });

  it("stops at GitHub's first short page", async () => {
    const gh = github({ [DEPLOYMENTS]: ok(FOREIGN_PAGE(29)) });
    await expect(githubPublished(gh.target)).resolves.toBeNull();
    expect(gh.calls).toHaveLength(1);
  });

  it("throws rather than answer none when GitHub holds more pages than Oxagen reads", async () => {
    const routes: Record<string, Reply> = { [DEPLOYMENTS]: ok(FOREIGN_PAGE(30)) };
    for (let page = 2; page <= 10; page++)
      routes[`${DEPLOYMENTS}&page=${page}`] = ok(FOREIGN_PAGE(30));
    const gh = github(routes);
    await expect(githubPublished(gh.target)).rejects.toThrow(
      /more than 300 deployments to the steering environment/,
    );
    expect(gh.calls).toHaveLength(10);
  });
});

describe("githubOpenRevert", () => {
  const COMMIT_P = `GET ${GH}/git/commits/${P}`;
  const COMMIT_R = `GET ${GH}/git/commits/${R}`;
  const REVERT_TIP = ok({
    sha: R,
    tree: { sha: TREE_P },
    parents: [{ sha: S2 }],
    message: revertMessage(PUBLISHED),
  });

  function pull(number: number, ref: string): GithubPullFixture {
    return { ...fixture<GithubPullFixture>("github-pull"), number, head: { ref } };
  }

  it("writes the commit, the branch, the pull request, and the check run", async () => {
    const gh = github({
      [COMMIT_P]: ok(fixture("github-git-commit-published")),
      [REF]: fail(404, "Not Found"),
      [`POST ${GH}/git/commits`]: ok({ sha: R }, 201),
      [`POST ${GH}/git/refs`]: ok({ ref: `refs/heads/${BRANCH}`, object: { sha: R } }, 201),
      [PULLS]: ok([]),
      [`POST ${GH}/pulls`]: ok(fixture("github-pull"), 201),
      [`POST ${GH}/check-runs`]: ok({ id: 77 }, 201),
    });
    await expect(
      githubOpenRevert(gh.target, PUBLISHED, DIVERGENCE, null),
    ).resolves.toBe(12);
    expect(gh.sent(`POST ${GH}/git/commits`)[0]!.body).toEqual({
      message: revertMessage(PUBLISHED),
      tree: TREE_P,
      parents: [S2],
    });
    expect(gh.sent(`POST ${GH}/git/refs`)[0]!.body).toEqual({
      ref: `refs/heads/${BRANCH}`,
      sha: R,
    });
    expect(gh.sent(`POST ${GH}/pulls`)[0]!.body).toEqual({
      title: "Revert main to published version 7",
      head: BRANCH,
      base: "main",
      body:
        "Main holds 1 commit that no pull request merged: c3c3c3c. This pull request puts main back at published version 7, and a workspace admin merges it with Repair settings. Whoever changed main can propose the change again through a steering PR.",
    });
    expect(gh.sent(`POST ${GH}/check-runs`)[0]!.body).toMatchObject({
      name: "Oxagen steering",
      head_sha: R,
      status: "completed",
      conclusion: "success",
      external_id: "oxagen-steering-revert",
    });
    expect(gh.sent(CHECK_RUNS)).toHaveLength(0);
  });

  it("reuses an unchanged branch and pull request without writing", async () => {
    const gh = github({
      [COMMIT_P]: ok(fixture("github-git-commit-published")),
      [REF]: ok({ ref: `refs/heads/${BRANCH}`, object: { sha: R, type: "commit" } }),
      [COMMIT_R]: REVERT_TIP,
      [PULLS]: ok([fixture("github-pull")]),
      [CHECK_RUNS]: ok({
        total_count: 1,
        check_runs: [
          {
            id: 77,
            name: "Oxagen steering",
            status: "completed",
            conclusion: "success",
            external_id: "oxagen-steering-revert",
          },
        ],
      }),
    });
    await expect(
      githubOpenRevert(gh.target, PUBLISHED, DIVERGENCE, 12),
    ).resolves.toBe(12);
    expect(gh.sent(`POST ${GH}/git/commits`)).toHaveLength(0);
    expect(gh.writes()).toEqual([]);
  });

  it("posts the check run again when the reused commit lacks it", async () => {
    const gh = github({
      [COMMIT_P]: ok(fixture("github-git-commit-published")),
      [REF]: ok({ ref: `refs/heads/${BRANCH}`, object: { sha: R, type: "commit" } }),
      [COMMIT_R]: REVERT_TIP,
      [PULLS]: ok([fixture("github-pull")]),
      [CHECK_RUNS]: ok({ total_count: 0, check_runs: [] }),
      [`POST ${GH}/check-runs`]: ok({ id: 78 }, 201),
    });
    await expect(
      githubOpenRevert(gh.target, PUBLISHED, DIVERGENCE, null),
    ).resolves.toBe(12);
    expect(gh.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${GH}/check-runs`,
    ]);
  });

  it("moves a stale branch after GitHub refuses to create it with a 422", async () => {
    const gh = github({
      [COMMIT_P]: ok(fixture("github-git-commit-published")),
      [REF]: ok({ ref: `refs/heads/${BRANCH}`, object: { sha: HEAD, type: "commit" } }),
      [`GET ${GH}/git/commits/${HEAD}`]: ok({
        sha: HEAD,
        tree: { sha: TREE_OTHER },
        parents: [{ sha: X }],
      }),
      [`POST ${GH}/git/commits`]: ok({ sha: R }, 201),
      [`POST ${GH}/git/refs`]: fail(422, "Reference already exists"),
      [`PATCH ${GH}/git/refs/heads/${BRANCH}`]: ok({ ref: `refs/heads/${BRANCH}`, object: { sha: R } }),
      [PULLS]: ok([fixture("github-pull")]),
      [`POST ${GH}/check-runs`]: ok({ id: 79 }, 201),
    });
    await expect(
      githubOpenRevert(gh.target, PUBLISHED, DIVERGENCE, null),
    ).resolves.toBe(12);
    expect(gh.sent(`PATCH ${GH}/git/refs/heads/${BRANCH}`)[0]!.body).toEqual({
      sha: R,
      force: true,
    });
  });

  it("finds the pull request GitHub refused as a duplicate with a 422", async () => {
    const gh = github({
      [COMMIT_P]: ok(fixture("github-git-commit-published")),
      [REF]: fail(404, "Not Found"),
      [`POST ${GH}/git/commits`]: ok({ sha: R }, 201),
      [`POST ${GH}/git/refs`]: ok({ ref: `refs/heads/${BRANCH}` }, 201),
      [PULLS]: [ok([]), ok([fixture("github-pull")])],
      [`POST ${GH}/pulls`]: fail(422, "A pull request already exists"),
      [`POST ${GH}/check-runs`]: ok({ id: 80 }, 201),
    });
    await expect(
      githubOpenRevert(gh.target, PUBLISHED, DIVERGENCE, null),
    ).resolves.toBe(12);
    expect(gh.sent(PULLS)).toHaveLength(2);
  });

  it("throws when GitHub refuses the pull request and lists none", async () => {
    const gh = github({
      [COMMIT_P]: ok(fixture("github-git-commit-published")),
      [REF]: fail(404, "Not Found"),
      [`POST ${GH}/git/commits`]: ok({ sha: R }, 201),
      [`POST ${GH}/git/refs`]: ok({ ref: `refs/heads/${BRANCH}` }, 201),
      [PULLS]: ok([]),
      [`POST ${GH}/pulls`]: fail(422, "No commits between main and the branch"),
    });
    await expect(
      githubOpenRevert(gh.target, PUBLISHED, DIVERGENCE, null),
    ).rejects.toThrow(/No commits between main and the branch/);
  });

  it("closes a previous revert pull request for another main", async () => {
    const older = pull(11, "steering/revert-to-a1a1a1a-c3c3c3c");
    const gh = github({
      [COMMIT_P]: ok(fixture("github-git-commit-published")),
      [REF]: fail(404, "Not Found"),
      [`POST ${GH}/git/commits`]: ok({ sha: R }, 201),
      [`POST ${GH}/git/refs`]: ok({ ref: `refs/heads/${BRANCH}` }, 201),
      [`GET ${GH}/pulls/11`]: ok(older),
      [PULLS]: ok([]),
      [`POST ${GH}/pulls`]: ok(fixture("github-pull"), 201),
      [`POST ${GH}/check-runs`]: ok({ id: 81 }, 201),
      [`PATCH ${GH}/pulls/11`]: ok({ ...older, state: "closed" }),
    });
    await expect(
      githubOpenRevert(gh.target, PUBLISHED, DIVERGENCE, 11),
    ).resolves.toBe(12);
    expect(gh.sent(`PATCH ${GH}/pulls/11`)[0]!.body).toEqual({ state: "closed" });
  });

  it("closes a revert pull request retargeted away from main and opens one into main", async () => {
    const moved = { ...pull(12, BRANCH), base: { ref: "release" } };
    const gh = github({
      [COMMIT_P]: ok(fixture("github-git-commit-published")),
      [REF]: fail(404, "Not Found"),
      [`POST ${GH}/git/commits`]: ok({ sha: R }, 201),
      [`POST ${GH}/git/refs`]: ok({ ref: `refs/heads/${BRANCH}` }, 201),
      [`GET ${GH}/pulls/12`]: ok({ ...moved, state: "closed" }),
      [PULLS]: ok([moved]),
      [`PATCH ${GH}/pulls/12`]: ok({ ...moved, state: "closed" }),
      [`POST ${GH}/pulls`]: ok(pull(13, BRANCH), 201),
      [`POST ${GH}/check-runs`]: ok({ id: 82 }, 201),
    });
    await expect(
      githubOpenRevert(gh.target, PUBLISHED, DIVERGENCE, 12),
    ).resolves.toBe(13);
    expect(gh.sent(`PATCH ${GH}/pulls/12`)[0]!.body).toEqual({ state: "closed" });
    expect(gh.sent(`POST ${GH}/pulls`)[0]!.body).toMatchObject({
      head: BRANCH,
      base: "main",
    });
    expect(gh.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `PATCH ${GH}/pulls/12`,
      `POST ${GH}/git/commits`,
      `POST ${GH}/git/refs`,
      `POST ${GH}/pulls`,
      `POST ${GH}/check-runs`,
    ]);
  });

  // #4671: the branch write lands only after the retargeted pull request is
  // closed and read back as closed. On the old order, the force-push came
  // first, so auto-merge could land the app's commit on the other branch.
  it("closes a retargeted pull request before it force-moves a tampered branch (#4671)", async () => {
    const moved = { ...pull(12, BRANCH), base: { ref: "release" } };
    const gh = github({
      [PULLS]: ok([moved]),
      [`PATCH ${GH}/pulls/12`]: ok({ ...moved, state: "closed" }),
      [`GET ${GH}/pulls/12`]: ok({ ...moved, state: "closed" }),
      [COMMIT_P]: ok(fixture("github-git-commit-published")),
      // Someone pushed their own commit to the revert branch.
      [REF]: ok({ ref: `refs/heads/${BRANCH}`, object: { sha: HEAD, type: "commit" } }),
      [`GET ${GH}/git/commits/${HEAD}`]: ok({
        sha: HEAD,
        tree: { sha: TREE_OTHER },
        parents: [{ sha: S2 }],
      }),
      [`POST ${GH}/git/commits`]: ok({ sha: R }, 201),
      [`POST ${GH}/git/refs`]: fail(422, "Reference already exists"),
      [`PATCH ${GH}/git/refs/heads/${BRANCH}`]: ok({ object: { sha: R } }),
      [`POST ${GH}/pulls`]: ok(pull(13, BRANCH), 201),
      [`POST ${GH}/check-runs`]: ok({ id: 83 }, 201),
    });
    await expect(
      githubOpenRevert(gh.target, PUBLISHED, DIVERGENCE, 12),
    ).resolves.toBe(13);
    expect(gh.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `PATCH ${GH}/pulls/12`,
      `POST ${GH}/git/commits`,
      `POST ${GH}/git/refs`,
      `PATCH ${GH}/git/refs/heads/${BRANCH}`,
      `POST ${GH}/pulls`,
      `POST ${GH}/check-runs`,
    ]);
    // The read-back that proves the close happens before the first branch write.
    const order = gh.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf(`GET ${GH}/pulls/12`)).toBeLessThan(
      order.indexOf(`POST ${GH}/git/commits`),
    );
  });

  it("writes nothing to the branch when GitHub refuses to close a retargeted pull request (#4671)", async () => {
    const moved = { ...pull(12, BRANCH), base: { ref: "release" } };
    const gh = github({
      [PULLS]: ok([moved]),
      [`PATCH ${GH}/pulls/12`]: fail(403, "Resource not accessible by integration"),
    });
    await expect(
      githubOpenRevert(gh.target, PUBLISHED, DIVERGENCE, 12),
    ).rejects.toThrow(/Resource not accessible by integration/);
    expect(gh.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `PATCH ${GH}/pulls/12`,
    ]);
  });

  it("writes nothing to the branch when a closed pull request still reads as open (#4671)", async () => {
    const moved = { ...pull(12, BRANCH), base: { ref: "release" } };
    const gh = github({
      [PULLS]: ok([moved]),
      [`PATCH ${GH}/pulls/12`]: ok(moved),
      [`GET ${GH}/pulls/12`]: ok(moved),
    });
    await expect(
      githubOpenRevert(gh.target, PUBLISHED, DIVERGENCE, 12),
    ).rejects.toThrow(/still shows pull request #12 .* as open, so Oxagen wrote nothing/);
    expect(gh.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `PATCH ${GH}/pulls/12`,
    ]);
  });

  it("reuses a listed pull request into main without closing it", async () => {
    const gh = github({
      [COMMIT_P]: ok(fixture("github-git-commit-published")),
      [REF]: ok({ ref: `refs/heads/${BRANCH}`, object: { sha: R, type: "commit" } }),
      [COMMIT_R]: REVERT_TIP,
      [PULLS]: ok([fixture("github-pull")]),
      [CHECK_RUNS]: ok({
        total_count: 1,
        check_runs: [{ conclusion: "success", external_id: "oxagen-steering-revert" }],
      }),
    });
    await expect(
      githubOpenRevert(gh.target, PUBLISHED, DIVERGENCE, null),
    ).resolves.toBe(12);
    expect(gh.writes()).toEqual([]);
  });
});

describe("githubCloseRevert", () => {
  it("closes an open revert pull request", async () => {
    const gh = github({
      [`GET ${GH}/pulls/12`]: ok(fixture("github-pull")),
      [`PATCH ${GH}/pulls/12`]: ok({}),
    });
    await githubCloseRevert(gh.target, 12);
    expect(gh.sent(`PATCH ${GH}/pulls/12`)).toHaveLength(1);
  });

  it("leaves a pull request from another branch open", async () => {
    const other = { ...fixture<GithubPullFixture>("github-pull"), head: { ref: "steering/add-rule" } };
    const gh = github({ [`GET ${GH}/pulls/12`]: ok(other) });
    await githubCloseRevert(gh.target, 12);
    expect(gh.writes()).toEqual([]);
  });

  it("does nothing for a closed or missing pull request", async () => {
    const closed = { ...fixture<GithubPullFixture>("github-pull"), state: "closed" };
    const gh = github({
      [`GET ${GH}/pulls/12`]: ok(closed),
      [`GET ${GH}/pulls/13`]: fail(404, "Not Found"),
    });
    await githubCloseRevert(gh.target, 12);
    await githubCloseRevert(gh.target, 13);
    expect(gh.writes()).toEqual([]);
  });
});

// ── GitLab ───────────────────────────────────────────────────────────────────

const GL = "/projects/812";

function gitlab(routes: Record<string, Reply | Reply[]>) {
  const s = server("https://gitlab.com/api/v4", routes);
  const target: GitlabHistoryTarget = {
    rest: createGitlabRest({ token: "glpat-test", fetch: s.fetch }),
    projectId: 812,
    bot: { symbol: "oxagen-steering", user_id: 4242, username: "oxagen-steering-bot" },
  };
  return { ...s, target };
}

interface GitlabCommitFixture {
  id: string;
  message: string;
  parent_ids: string[];
}

interface GitlabCompareFixture {
  commits: GitlabCommitFixture[];
  diffs: unknown[];
  compare_timeout: boolean;
}

interface GitlabDeploymentFixture {
  sha: string;
}

function glCommit(id: string, parents: string[], message: string): GitlabCommitFixture {
  return { id, message, parent_ids: parents };
}

function glBranch(name: string, id: string, parents: string[]): Reply {
  return ok({ name, commit: { id, short_id: id.slice(0, 8), parent_ids: parents }, merged: false });
}

function sameFiles(): Reply {
  return ok({ commits: [], diffs: [], compare_timeout: false, compare_same_ref: false });
}

const GL_DEPLOYMENTS = `GET ${GL}/deployments?environment=steering&status=success&order_by=id&sort=desc&per_page=20`;
const GL_MAIN = `GET ${GL}/repository/branches/main`;
const GL_BASE = `GET ${GL}/repository/merge_base?refs[]=${P}&refs[]=${S2}`;
const GL_COMPARE = `GET ${GL}/repository/compare?from=${P}&to=${S2}&straight=true`;

describe("gitlabPublished", () => {
  it("takes the bot's newest deployment and reads the version trailer", async () => {
    const gl = gitlab({
      [GL_DEPLOYMENTS]: ok(fixture("gitlab-deployments")),
      [`GET ${GL}/repository/commits/${P}`]: ok(fixture("gitlab-commit-published")),
    });
    await expect(gitlabPublished(gl.target)).resolves.toEqual({ sha: P, version: 7 });
  });

  it("reads the seed commit as version 1", async () => {
    const seed = glCommit(P, [], "Seed the steering repo\n\nOxagen wrote this commit.");
    const gl = gitlab({
      [GL_DEPLOYMENTS]: ok(fixture("gitlab-deployments")),
      [`GET ${GL}/repository/commits/${P}`]: ok(seed),
    });
    await expect(gitlabPublished(gl.target)).resolves.toEqual({ sha: P, version: 1 });
  });

  it("reports an unknown version for a commit with no trailer", async () => {
    const gl = gitlab({
      [GL_DEPLOYMENTS]: ok(fixture("gitlab-deployments")),
      [`GET ${GL}/repository/commits/${P}`]: ok(glCommit(P, [OLD], "Merge branch 'rules'")),
    });
    await expect(gitlabPublished(gl.target)).resolves.toEqual({ sha: P, version: null });
  });

  it("returns null when the bot recorded no deployment", async () => {
    const deployments = fixture<GitlabDeploymentFixture[]>("gitlab-deployments");
    const gl = gitlab({ [GL_DEPLOYMENTS]: ok(deployments.slice(0, 1)) });
    await expect(gitlabPublished(gl.target)).resolves.toBeNull();
  });

  it("finds the bot's deployment on the second page (#4653)", async () => {
    const others = Array.from({ length: 20 }, () => ({ sha: X, user: { id: 9 } }));
    const gl = gitlab({
      [GL_DEPLOYMENTS]: ok(others),
      [`${GL_DEPLOYMENTS}&page=2`]: ok(fixture("gitlab-deployments")),
      [`GET ${GL}/repository/commits/${P}`]: ok(fixture("gitlab-commit-published")),
    });
    await expect(gitlabPublished(gl.target)).resolves.toEqual({ sha: P, version: 7 });
  });
});

describe("gitlabDiverged", () => {
  it("passes a main that is the published commit", async () => {
    const gl = gitlab({ [GL_MAIN]: glBranch("main", P, [OLD]) });
    await expect(gitlabDiverged(gl.target, PUBLISHED)).resolves.toBeNull();
    expect(gl.calls).toHaveLength(1);
  });

  it("passes a main ahead by trailered squash merges", async () => {
    const compare = fixture<GitlabCompareFixture>("gitlab-compare-foreign");
    compare.commits = compare.commits.filter((c) => c.id !== X);
    const gl = gitlab({
      [GL_MAIN]: glBranch("main", S2, [X]),
      [GL_BASE]: ok({ id: P }),
      [GL_COMPARE]: ok(compare),
    });
    await expect(gitlabDiverged(gl.target, PUBLISHED)).resolves.toBeNull();
  });

  it("names a foreign commit in either listing order", async () => {
    const compare = fixture<GitlabCompareFixture>("gitlab-compare-foreign");
    const reversed = { ...compare, commits: [...compare.commits].reverse() };
    for (const listed of [compare, reversed]) {
      const gl = gitlab({
        [GL_MAIN]: glBranch("main", S2, [X]),
        [GL_BASE]: ok({ id: P }),
        [GL_COMPARE]: ok(listed),
      });
      await expect(gitlabDiverged(gl.target, PUBLISHED)).resolves.toEqual(DIVERGENCE);
    }
  });

  it("passes a rewritten main that holds the published files", async () => {
    const gl = gitlab({
      [GL_MAIN]: glBranch("main", S2, [X]),
      [GL_BASE]: ok({ id: OLD }),
      [GL_COMPARE]: sameFiles(),
    });
    await expect(gitlabDiverged(gl.target, PUBLISHED)).resolves.toBeNull();
  });

  it("flags a merge base other than the published commit", async () => {
    const gl = gitlab({
      [GL_MAIN]: glBranch("main", S2, [X]),
      [GL_BASE]: ok({ id: OLD }),
      [GL_COMPARE]: ok(fixture("gitlab-compare-foreign")),
    });
    await expect(gitlabDiverged(gl.target, PUBLISHED)).resolves.toEqual({
      reason: "main no longer contains the published commit a1a1a1a",
      main_sha: S2,
    });
  });

  it("flags a published commit GitLab no longer knows", async () => {
    const gl = gitlab({
      [GL_MAIN]: glBranch("main", S2, [X]),
      [GL_BASE]: fail(400, "Look up failed for one or more refs"),
    });
    await expect(gitlabDiverged(gl.target, PUBLISHED)).resolves.toEqual({
      reason: "main no longer contains the published commit a1a1a1a",
      main_sha: S2,
    });
    expect(gl.calls).toHaveLength(2);
  });

  it("forgives commits a merged revert put back", async () => {
    const compare = fixture<GitlabCompareFixture>("gitlab-compare-foreign");
    compare.commits = [
      glCommit(X, [P], "Edit the release notes rule by hand"),
      glCommit(R, [X], revertMessage(PUBLISHED)),
      glCommit(S2, [R], mergeMessage("Tighten the review checklist", 43, 8)),
    ];
    const probe = `GET ${GL}/repository/compare?from=${R}&to=${P}&straight=true`;
    const gl = gitlab({
      [GL_MAIN]: glBranch("main", S2, [R]),
      [GL_BASE]: ok({ id: P }),
      [GL_COMPARE]: ok(compare),
      [probe]: sameFiles(),
    });
    await expect(gitlabDiverged(gl.target, PUBLISHED)).resolves.toBeNull();
    expect(gl.sent(probe)).toHaveLength(1);
  });

  it("flags a compare GitLab could not finish, without probing reverts", async () => {
    const compare = fixture<GitlabCompareFixture>("gitlab-compare-foreign");
    compare.compare_timeout = true;
    compare.commits.push(glCommit(R, [S2], revertMessage(PUBLISHED)));
    const gl = gitlab({
      [GL_MAIN]: glBranch("main", S2, [X]),
      [GL_BASE]: ok({ id: P }),
      [GL_COMPARE]: ok(compare),
    });
    await expect(gitlabDiverged(gl.target, PUBLISHED)).resolves.toEqual({
      reason:
        "main holds more commits since the published commit a1a1a1a than Oxagen can read",
      main_sha: S2,
    });
    expect(gl.calls).toHaveLength(3);
  });
});

describe("gitlabOpenRevert", () => {
  const BRANCH_GET = `GET ${GL}/repository/branches/steering%2Frevert-to-a1a1a1a-d4d4d4d`;
  const REVERT_COMPARE = `GET ${GL}/repository/compare?from=${S2}&to=${P}&straight=true`;
  const REQUESTS = `GET ${GL}/merge_requests?state=opened&source_branch=steering%2Frevert-to-a1a1a1a-d4d4d4d`;
  const STATUS = `POST ${GL}/statuses/${R}`;

  function file(path: string): string {
    return `GET ${GL}/repository/files/${encodeURIComponent(path)}?ref=${P}`;
  }

  function request(iid: number, source: string, state = "opened", target = "main") {
    return { iid, state, source_branch: source, target_branch: target, title: "Revert main" };
  }

  it("writes the commit, the merge request, and the status", async () => {
    const content = fixture<{ content: string }>("gitlab-file").content;
    const gl = gitlab({
      [BRANCH_GET]: fail(404, "404 Branch Not Found"),
      [REVERT_COMPARE]: ok(fixture("gitlab-compare-revert")),
      [file("rules/release-notes.md")]: ok(fixture("gitlab-file")),
      [file("rules/review-checklist.md")]: ok(fixture("gitlab-file")),
      [file("rules/house-style.md")]: ok(fixture("gitlab-file")),
      [`POST ${GL}/repository/commits`]: ok(glCommit(R, [S2], revertMessage(PUBLISHED)), 201),
      [REQUESTS]: ok([]),
      [`POST ${GL}/merge_requests`]: ok(request(5, BRANCH), 201),
      [STATUS]: ok({ id: 1, status: "success" }, 201),
    });
    await expect(
      gitlabOpenRevert(gl.target, PUBLISHED, DIVERGENCE, null),
    ).resolves.toBe(5);
    expect(gl.sent(`POST ${GL}/repository/commits`)[0]!.body).toEqual({
      branch: BRANCH,
      start_sha: S2,
      commit_message: revertMessage(PUBLISHED),
      force: true,
      actions: [
        { action: "update", file_path: "rules/release-notes.md", content, encoding: "base64" },
        { action: "create", file_path: "rules/review-checklist.md", content, encoding: "base64" },
        { action: "delete", file_path: "rules/scratch.md" },
        {
          action: "move",
          previous_path: "rules/style.md",
          file_path: "rules/house-style.md",
          content,
          encoding: "base64",
        },
      ],
    });
    expect(gl.sent(`POST ${GL}/merge_requests`)[0]!.body).toEqual({
      source_branch: BRANCH,
      target_branch: "main",
      title: "Revert main to published version 7",
      description:
        "Main holds 1 commit that no pull request merged: c3c3c3c. This merge request puts main back at published version 7, and a workspace admin merges it with Repair settings. Whoever changed main can propose the change again through a steering PR.",
      remove_source_branch: true,
    });
    expect(gl.sent(STATUS)[0]!.body).toMatchObject({
      state: "success",
      name: "Oxagen steering",
    });
  });

  it("reuses an unchanged branch and merge request without writing a commit", async () => {
    const gl = gitlab({
      [BRANCH_GET]: glBranch(BRANCH, R, [S2]),
      [`GET ${GL}/repository/compare?from=${R}&to=${P}&straight=true`]: sameFiles(),
      [REQUESTS]: ok([request(5, BRANCH)]),
      [STATUS]: fail(400, "Cannot transition status via :run from :success"),
    });
    await expect(
      gitlabOpenRevert(gl.target, PUBLISHED, DIVERGENCE, 5),
    ).resolves.toBe(5);
    expect(gl.sent(`POST ${GL}/repository/commits`)).toHaveLength(0);
    expect(gl.writes().map((c) => `${c.method} ${c.path}`)).toEqual([STATUS]);
  });

  it("finds the merge request GitLab refused as a duplicate with a 409", async () => {
    const gl = gitlab({
      [BRANCH_GET]: glBranch(BRANCH, R, [S2]),
      [`GET ${GL}/repository/compare?from=${R}&to=${P}&straight=true`]: sameFiles(),
      [REQUESTS]: [ok([]), ok([request(6, BRANCH)])],
      [`POST ${GL}/merge_requests`]: fail(409, "Another open merge request already exists"),
      [STATUS]: ok({ id: 2 }, 201),
    });
    await expect(
      gitlabOpenRevert(gl.target, PUBLISHED, DIVERGENCE, null),
    ).resolves.toBe(6);
  });

  it("closes a previous revert merge request for another main", async () => {
    const gl = gitlab({
      [BRANCH_GET]: glBranch(BRANCH, R, [S2]),
      [`GET ${GL}/repository/compare?from=${R}&to=${P}&straight=true`]: sameFiles(),
      [`GET ${GL}/merge_requests/3`]: ok(request(3, "steering/revert-to-a1a1a1a-c3c3c3c")),
      [REQUESTS]: ok([request(5, BRANCH)]),
      [STATUS]: ok({ id: 3 }, 201),
      [`PUT ${GL}/merge_requests/3`]: ok(request(3, "steering/revert-to-a1a1a1a-c3c3c3c", "closed")),
    });
    await expect(
      gitlabOpenRevert(gl.target, PUBLISHED, DIVERGENCE, 3),
    ).resolves.toBe(5);
    expect(gl.sent(`PUT ${GL}/merge_requests/3`)[0]!.body).toEqual({ state_event: "close" });
  });

  it("closes a revert merge request retargeted away from main and opens one into main", async () => {
    const moved = request(5, BRANCH, "opened", "release");
    const closed = request(5, BRANCH, "closed", "release");
    const gl = gitlab({
      [BRANCH_GET]: glBranch(BRANCH, R, [S2]),
      [`GET ${GL}/repository/compare?from=${R}&to=${P}&straight=true`]: sameFiles(),
      [`GET ${GL}/merge_requests/5`]: ok(closed),
      [REQUESTS]: ok([moved]),
      [`PUT ${GL}/merge_requests/5`]: ok(closed),
      [`POST ${GL}/merge_requests`]: ok(request(6, BRANCH), 201),
      [STATUS]: ok({ id: 4 }, 201),
    });
    await expect(
      gitlabOpenRevert(gl.target, PUBLISHED, DIVERGENCE, 5),
    ).resolves.toBe(6);
    expect(gl.sent(`PUT ${GL}/merge_requests/5`)[0]!.body).toEqual({ state_event: "close" });
    expect(gl.sent(`POST ${GL}/merge_requests`)[0]!.body).toMatchObject({
      source_branch: BRANCH,
      target_branch: "main",
    });
    expect(gl.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `PUT ${GL}/merge_requests/5`,
      `POST ${GL}/merge_requests`,
      STATUS,
    ]);
  });

  // #4671: the revert commit force-moves the branch, so it lands only after
  // the retargeted merge request is closed and read back as closed.
  it("closes a retargeted merge request before it force-moves a tampered branch (#4671)", async () => {
    const moved = request(5, BRANCH, "opened", "release");
    const closed = request(5, BRANCH, "closed", "release");
    const gl = gitlab({
      [REQUESTS]: ok([moved]),
      [`PUT ${GL}/merge_requests/5`]: ok(closed),
      [`GET ${GL}/merge_requests/5`]: ok(closed),
      // Someone pushed their own commit to the revert branch.
      [BRANCH_GET]: glBranch(BRANCH, HEAD, [X]),
      [REVERT_COMPARE]: ok(fixture("gitlab-compare-revert")),
      [file("rules/release-notes.md")]: ok(fixture("gitlab-file")),
      [file("rules/review-checklist.md")]: ok(fixture("gitlab-file")),
      [file("rules/house-style.md")]: ok(fixture("gitlab-file")),
      [`POST ${GL}/repository/commits`]: ok(glCommit(R, [S2], revertMessage(PUBLISHED)), 201),
      [`POST ${GL}/merge_requests`]: ok(request(6, BRANCH), 201),
      [STATUS]: ok({ id: 5 }, 201),
    });
    await expect(
      gitlabOpenRevert(gl.target, PUBLISHED, DIVERGENCE, 5),
    ).resolves.toBe(6);
    expect(gl.sent(`POST ${GL}/repository/commits`)[0]!.body).toMatchObject({
      branch: BRANCH,
      start_sha: S2,
      force: true,
    });
    expect(gl.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `PUT ${GL}/merge_requests/5`,
      `POST ${GL}/repository/commits`,
      `POST ${GL}/merge_requests`,
      STATUS,
    ]);
    const order = gl.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf(`GET ${GL}/merge_requests/5`)).toBeLessThan(
      order.indexOf(`POST ${GL}/repository/commits`),
    );
  });

  it("writes nothing to the branch when GitLab refuses to close a retargeted merge request (#4671)", async () => {
    const moved = request(5, BRANCH, "opened", "release");
    const gl = gitlab({
      [REQUESTS]: ok([moved]),
      [`PUT ${GL}/merge_requests/5`]: fail(403, "403 Forbidden"),
    });
    await expect(
      gitlabOpenRevert(gl.target, PUBLISHED, DIVERGENCE, 5),
    ).rejects.toThrow();
    expect(gl.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `PUT ${GL}/merge_requests/5`,
    ]);
  });

  it("writes nothing to the branch when a closed merge request still reads as open (#4671)", async () => {
    const moved = request(5, BRANCH, "opened", "release");
    const gl = gitlab({
      [REQUESTS]: ok([moved]),
      [`PUT ${GL}/merge_requests/5`]: ok(moved),
      [`GET ${GL}/merge_requests/5`]: ok(moved),
    });
    await expect(
      gitlabOpenRevert(gl.target, PUBLISHED, DIVERGENCE, 5),
    ).rejects.toThrow(/still shows merge request !5 .* as open, so Oxagen wrote nothing/);
    expect(gl.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `PUT ${GL}/merge_requests/5`,
    ]);
  });

  it("reuses a listed merge request into main without closing it", async () => {
    const gl = gitlab({
      [BRANCH_GET]: glBranch(BRANCH, R, [S2]),
      [`GET ${GL}/repository/compare?from=${R}&to=${P}&straight=true`]: sameFiles(),
      [REQUESTS]: ok([request(5, BRANCH)]),
      [STATUS]: fail(400, "Cannot transition status via :run from :success"),
    });
    await expect(
      gitlabOpenRevert(gl.target, PUBLISHED, DIVERGENCE, null),
    ).resolves.toBe(5);
    expect(gl.writes().map((c) => `${c.method} ${c.path}`)).toEqual([STATUS]);
  });

  it("refuses to write an empty revert commit", async () => {
    const gl = gitlab({
      [REQUESTS]: ok([]),
      [BRANCH_GET]: fail(404, "404 Branch Not Found"),
      [REVERT_COMPARE]: sameFiles(),
    });
    await expect(
      gitlabOpenRevert(gl.target, PUBLISHED, DIVERGENCE, null),
    ).rejects.toThrow(/nothing to revert/);
    expect(gl.writes()).toEqual([]);
  });

  it("refuses to write from a compare GitLab could not finish", async () => {
    const compare = fixture<GitlabCompareFixture>("gitlab-compare-revert");
    compare.compare_timeout = true;
    const gl = gitlab({
      [REQUESTS]: ok([]),
      [BRANCH_GET]: fail(404, "404 Branch Not Found"),
      [REVERT_COMPARE]: ok(compare),
    });
    await expect(
      gitlabOpenRevert(gl.target, PUBLISHED, DIVERGENCE, null),
    ).rejects.toThrow(/timed out/);
  });
});

describe("gitlabCloseRevert", () => {
  it("closes an open revert merge request", async () => {
    const gl = gitlab({
      [`GET ${GL}/merge_requests/5`]: ok({ iid: 5, state: "opened", source_branch: BRANCH }),
      [`PUT ${GL}/merge_requests/5`]: ok({ iid: 5, state: "closed" }),
    });
    await gitlabCloseRevert(gl.target, 5);
    expect(gl.sent(`PUT ${GL}/merge_requests/5`)[0]!.body).toEqual({ state_event: "close" });
  });

  it("leaves other, merged, and missing merge requests alone", async () => {
    const gl = gitlab({
      [`GET ${GL}/merge_requests/5`]: ok({ iid: 5, state: "opened", source_branch: "steering/add-rule" }),
      [`GET ${GL}/merge_requests/6`]: ok({ iid: 6, state: "merged", source_branch: BRANCH }),
      [`GET ${GL}/merge_requests/7`]: fail(404, "404 Not found"),
    });
    await gitlabCloseRevert(gl.target, 5);
    await gitlabCloseRevert(gl.target, 6);
    await gitlabCloseRevert(gl.target, 7);
    expect(gl.writes()).toEqual([]);
  });
});
