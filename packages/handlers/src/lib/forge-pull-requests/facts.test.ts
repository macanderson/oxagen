// The facts each forge answer maps to (ADR-288). A delivery, GitHub's REST
// answer and GitLab's answer must name the same pull request the same way,
// or two senders would write two rows for one pull request.
import { describe, expect, it } from "vitest";
import {
  diffKeyOf,
  githubClientFacts,
  githubDeliveryFacts,
  gitlabClientFacts,
  pullKeyOf,
  shaOf,
} from "./facts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE = "c".repeat(40);

function delivery(over: Record<string, unknown> = {}) {
  return {
    action: "synchronize",
    repository: { id: 991, full_name: "Acme/API" },
    pull_request: {
      number: 42,
      html_url: "https://github.com/Acme/API/pull/42",
      title: "Cut the release",
      user: { login: "octo" },
      state: "open",
      draft: true,
      merged: false,
      merge_commit_sha: MERGE,
      merged_at: null,
      closed_at: null,
      updated_at: "2026-10-02T10:00:00Z",
      base: { ref: "main", sha: BASE, repo: { id: 991, full_name: "Acme/API" } },
      head: { ref: "release/3.2", sha: HEAD.toUpperCase() },
      ...over,
    },
  };
}

describe("githubDeliveryFacts", () => {
  it("maps a delivery, keyed on the base repository's id, with the path in lower case", () => {
    expect(githubDeliveryFacts(delivery())).toEqual({
      host: "github.com",
      providerRepositoryId: "991",
      repository: "acme/api",
      number: 42,
      url: "https://github.com/Acme/API/pull/42",
      title: "Cut the release",
      authorLogin: "octo",
      state: "open",
      draft: true,
      baseRef: "main",
      headRef: "release/3.2",
      headSha: HEAD,
      baseSha: BASE,
      mergeBaseSha: null,
      // An open pull request's merge commit is GitHub's test merge; it is not kept.
      mergeCommitSha: null,
      mergedAt: null,
      closedAt: null,
      sourceUpdatedAt: "2026-10-02T10:00:00.000Z",
    });
  });

  it("names a merged pull request merged, never a draft, with its merge commit", () => {
    const facts = githubDeliveryFacts(
      delivery({
        state: "closed",
        merged: true,
        draft: true,
        merged_at: "2026-10-02T11:00:00Z",
        closed_at: "2026-10-02T11:00:00Z",
      }),
    );
    expect(facts).toMatchObject({
      state: "merged",
      draft: false,
      mergeCommitSha: MERGE,
      mergedAt: "2026-10-02T11:00:00.000Z",
    });
  });

  it("names a closed, unmerged pull request closed", () => {
    expect(githubDeliveryFacts(delivery({ state: "closed" }))).toMatchObject({
      state: "closed",
      draft: false,
      mergeCommitSha: null,
    });
  });

  it.each([
    ["no pull request", { repository: { id: 1, full_name: "a/b" } }],
    ["no head commit", delivery({ head: { ref: "x", sha: null } })],
    ["a head that is not a commit id", delivery({ head: { ref: "x", sha: "main" } })],
    ["no number", delivery({ number: 0 })],
    ["no URL", delivery({ html_url: "" })],
  ])("answers null for %s (negative)", (_label, body) => {
    expect(githubDeliveryFacts(body as Record<string, unknown>)).toBeNull();
  });
});

describe("githubClientFacts", () => {
  const pr = {
    number: 42,
    title: "Cut the release",
    htmlUrl: "https://github.com/acme/api/pull/42",
    state: "open" as const,
    draft: false,
    merged: false,
    authorLogin: "octo",
    authorAvatarUrl: null,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-02T10:00:00Z",
    body: null,
    baseRef: "main",
    headRef: "release/3.2",
    headSha: HEAD,
    mergeCommitSha: MERGE,
    mergedAt: null,
    closedAt: null,
    baseSha: BASE,
    baseRepositoryId: "991",
    baseRepository: "Acme/API",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    commits: 1,
    commentCount: 0,
    reviewCommentCount: 0,
    labels: [],
  };

  it("maps REST to the same facts a delivery gives", () => {
    expect(githubClientFacts("acme/api", pr)).toEqual(
      githubDeliveryFacts(
        delivery({
          draft: false,
          html_url: "https://github.com/acme/api/pull/42",
          head: { ref: "release/3.2", sha: HEAD },
        }),
      ),
    );
  });

  it("answers null without the base repository's id or a head (negative)", () => {
    const { baseRepositoryId: _id, ...withoutId } = pr;
    expect(githubClientFacts("acme/api", withoutId)).toBeNull();
    expect(githubClientFacts("acme/api", { ...pr, headSha: null })).toBeNull();
  });
});

describe("gitlabClientFacts", () => {
  const mr = {
    iid: 9,
    webUrl: "https://gitlab.com/acme/platform/web/-/merge_requests/9",
    title: "Fix tags",
    description: "",
    state: "opened" as const,
    sourceBranch: "fix/tags",
    targetBranch: "main",
    sha: HEAD,
    mergeCommitSha: null,
    squashCommitSha: null,
    mergedAt: null,
    detailedMergeStatus: null,
    projectId: "4242",
    draft: false,
    updatedAt: "2026-10-02T10:00:00Z",
    authorLogin: "mb",
    baseSha: MERGE,
    targetSha: BASE,
  };

  it("keys on the project id and carries GitLab's merge base", () => {
    expect(gitlabClientFacts("Acme/Platform/Web", mr)).toMatchObject({
      host: "gitlab.com",
      providerRepositoryId: "4242",
      repository: "acme/platform/web",
      number: 9,
      state: "open",
      headSha: HEAD,
      baseSha: BASE,
      mergeBaseSha: MERGE,
      authorLogin: "mb",
    });
  });

  it("reads locked as open and a squash merge's commit as the merge commit", () => {
    expect(gitlabClientFacts("a/b", { ...mr, state: "locked" })).toMatchObject({
      state: "open",
    });
    expect(
      gitlabClientFacts("a/b", {
        ...mr,
        state: "merged",
        squashCommitSha: MERGE,
      }),
    ).toMatchObject({ state: "merged", mergeCommitSha: MERGE });
  });

  it("answers null with no head commit (negative)", () => {
    expect(gitlabClientFacts("a/b", { ...mr, sha: null })).toBeNull();
  });
});

describe("keys", () => {
  it("names a pull request the same way whichever case its path came in", () => {
    expect(pullKeyOf("ws", "github", "Acme/API", 42)).toBe(
      pullKeyOf("ws", "github", "acme/api", 42),
    );
  });

  it("puts the tenant first and the head last in a diff key", () => {
    expect(
      diffKeyOf({
        orgId: "org",
        workspaceId: "ws",
        provider: "gitlab",
        providerRepositoryId: "42/x",
        number: 9,
        headSha: HEAD,
      }),
    ).toBe(`pr-diffs/org/ws/gitlab/42%2Fx/9/${HEAD}.diff`);
  });

  it("reads a sha in either case and refuses anything else", () => {
    expect(shaOf(HEAD.toUpperCase())).toBe(HEAD);
    expect(shaOf("e".repeat(64))).toBe("e".repeat(64));
    expect(shaOf("abc")).toBeNull();
    expect(shaOf(null)).toBeNull();
  });
});
