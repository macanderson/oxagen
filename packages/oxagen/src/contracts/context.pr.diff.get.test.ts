import { describe, expect, it } from "vitest";
import {
  CONTEXT_PR_DIFF_MAX_FILES,
  contextPrDiffGet,
} from "./context.pr.diff.get";

describe("get_context_pr_diff contract", () => {
  it("is a read every workspace role may make", () => {
    expect(contextPrDiffGet.name).toBe("get_context_pr_diff");
    expect(contextPrDiffGet.mutates).toBe(false);
    expect(contextPrDiffGet.defaultRoles.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
      Viewer: "allow",
    });
  });

  it("answers each file with both sides, and caps the file list", () => {
    const file = {
      path: ".oxagen/rules/a.toml",
      status: "added" as const,
      before: null,
      after: "x",
      truncated: false,
    };
    const answer = (files: (typeof file)[]) =>
      contextPrDiffGet.output.safeParse({
        proposalId: "prp_1",
        state: "diff",
        baseRef: "main",
        headSha: "abc",
        files,
        moreFiles: false,
      }).success;
    expect(answer([file])).toBe(true);
    expect(
      answer(Array.from({ length: CONTEXT_PR_DIFF_MAX_FILES + 1 }, () => file)),
    ).toBe(false);
  });
});
