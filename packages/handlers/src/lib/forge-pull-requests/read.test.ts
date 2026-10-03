// The change set's roll-up (ADR-292): files union by repository with summed
// counts, a path two pull requests touched names both, a pull request closed
// unmerged is listed and left out, and a revision with no counts makes the
// repository's totals unknown rather than wrong.
import { describe, expect, it } from "vitest";
import type { ChangeSetPullRequest } from "@oxagen/oxagen/contracts/forge.changes.get";
import { pullRequestEntry, rollUp } from "./read";

function entry(over: Partial<ChangeSetPullRequest>): ChangeSetPullRequest {
  return {
    id: "fpr_1",
    provider: "github",
    repository: "acme/api",
    number: 1,
    url: "https://github.com/acme/api/pull/1",
    title: null,
    state: "open",
    headSha: "a".repeat(40),
    baseRef: "main",
    headRef: "f",
    mergedAt: null,
    closedAt: null,
    stateSeenAt: "2026-10-03T00:00:00.000Z",
    revision: {
      id: "prv_1",
      headSha: "a".repeat(40),
      mergeBaseSha: null,
      diffStatus: "stored",
      complete: true,
      limitations: [],
      filesChanged: 1,
      additions: 3,
      deletions: 1,
      diffBytes: 100,
      capturedAt: "2026-10-03T00:00:00.000Z",
    },
    files: [{ path: "a.ts", status: "modified", additions: 3, deletions: 1 }],
    moreFiles: false,
    ...over,
  };
}

describe("rollUp", () => {
  it("unions files per repository, sums counts, and names every pull request on a shared path", () => {
    const one = entry({});
    const two = entry({
      id: "fpr_2",
      number: 2,
      revision: { ...one.revision!, id: "prv_2", additions: 5, deletions: 0 },
      files: [
        { path: "a.ts", status: "modified", additions: 2, deletions: 0 },
        { path: "b.ts", status: "added", additions: 3, deletions: 0 },
      ],
    });
    const web = entry({ id: "fpr_3", repository: "acme/web", number: 3 });
    expect(rollUp([two, web, one])).toEqual([
      {
        provider: "github",
        repository: "acme/api",
        pullRequests: 2,
        filesChanged: 2,
        additions: 8,
        deletions: 1,
        files: [
          { path: "a.ts", pullRequestIds: ["fpr_2", "fpr_1"], additions: 5, deletions: 1 },
          { path: "b.ts", pullRequestIds: ["fpr_2"], additions: 3, deletions: 0 },
        ],
        moreFiles: false,
      },
      expect.objectContaining({ repository: "acme/web", pullRequests: 1 }),
    ]);
  });

  it("lists a pull request closed unmerged and leaves it out of the roll-up", () => {
    expect(rollUp([entry({ state: "closed" })])).toEqual([]);
  });

  it("answers unknown totals when a revision carries no counts, never a partial sum (negative)", () => {
    const out = rollUp([
      entry({}),
      entry({
        id: "fpr_2",
        revision: null,
        files: [{ path: "c.ts", status: "added", additions: null, deletions: null }],
      }),
    ]);
    expect(out[0]).toMatchObject({ additions: null, deletions: null, filesChanged: 2 });
  });
});

describe("pullRequestEntry", () => {
  it("names an open draft as draft and a merged one as merged", () => {
    const base = {
      publicId: "fpr_9",
      provider: "github",
      repository: "acme/api",
      number: 9,
      url: "https://github.com/acme/api/pull/9",
      title: "t",
      state: "open",
      draft: true,
      headSha: "a".repeat(40),
      baseRef: "main",
      headRef: "f",
      mergedAt: null,
      closedAt: null,
      stateSeenAt: new Date("2026-10-03T00:00:00Z"),
    };
    expect(pullRequestEntry(base as never, null)).toMatchObject({
      id: "fpr_9",
      state: "draft",
      revision: null,
      files: [],
      moreFiles: false,
    });
    expect(
      pullRequestEntry({ ...base, state: "merged", draft: false } as never, null)
        .state,
    ).toBe("merged");
  });
});
