import { describe, expect, it } from "vitest";
import {
  CHANGE_SET_ID_PATTERNS,
  CHANGE_SET_MAX_PULL_REQUESTS,
  changeSetGet,
} from "./forge.changes.get";

describe("get_change_set contract", () => {
  it("is a read every workspace role may make", () => {
    expect(changeSetGet.name).toBe("get_change_set");
    expect(changeSetGet.mutates).toBe(false);
    expect(changeSetGet.defaultRoles.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
      Viewer: "allow",
    });
  });

  it("takes one of four scopes and refuses any other (negative)", () => {
    expect(changeSetGet.input.safeParse({ scope: "run", id: "tse_1" }).success).toBe(true);
    expect(changeSetGet.input.safeParse({ scope: "branch", id: "x" }).success).toBe(false);
    expect(changeSetGet.input.safeParse({ scope: "run", id: "" }).success).toBe(false);
  });

  it("names each scope's id shape", () => {
    expect(CHANGE_SET_ID_PATTERNS.run.test("arun_5f0c2e9a1b7d4c3e8f6a02")).toBe(true);
    expect(CHANGE_SET_ID_PATTERNS.work_order.test("wo_7Hk2")).toBe(true);
    expect(CHANGE_SET_ID_PATTERNS.work_item.test("wi_3Jq9")).toBe(true);
    expect(CHANGE_SET_ID_PATTERNS.issue.test("https://github.com/a/b/issues/7")).toBe(true);
    expect(CHANGE_SET_ID_PATTERNS.issue.test("https://github.com/a/b/pull/7")).toBe(false);
  });

  it("caps the pull requests one answer lists", () => {
    const pr = {
      id: "fpr_1",
      provider: "github",
      repository: "a/b",
      number: 1,
      url: "https://github.com/a/b/pull/1",
      title: null,
      state: "open",
      headSha: "a".repeat(40),
      baseRef: null,
      headRef: null,
      mergedAt: null,
      closedAt: null,
      stateSeenAt: "2026-10-03T00:00:00.000Z",
      revision: null,
      files: [],
      moreFiles: false,
    };
    const answer = (n: number) =>
      changeSetGet.output.safeParse({
        scope: "run",
        id: "tse_1",
        pullRequests: Array.from({ length: n }, () => pr),
        morePullRequests: false,
        repositories: [],
      }).success;
    expect(answer(CHANGE_SET_MAX_PULL_REQUESTS)).toBe(true);
    expect(answer(CHANGE_SET_MAX_PULL_REQUESTS + 1)).toBe(false);
  });
});
