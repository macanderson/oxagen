import { describe, expect, it } from "vitest";
import {
  STEERING_PR_DIFF_MAX_FILES,
  steeringPrDiffGet,
} from "./steering.pr.diff.get";

describe("get_steering_pr_diff contract", () => {
  it("is a read every workspace role may make", () => {
    expect(steeringPrDiffGet.name).toBe("get_steering_pr_diff");
    expect(steeringPrDiffGet.mutates).toBe(false);
    expect(steeringPrDiffGet.defaultRoles.workspace).toEqual({
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
      steeringPrDiffGet.output.safeParse({
        proposalId: "prp_1",
        state: "diff",
        baseRef: "main",
        headSha: "abc",
        files,
        moreFiles: false,
      }).success;
    expect(answer([file])).toBe(true);
    expect(
      answer(Array.from({ length: STEERING_PR_DIFF_MAX_FILES + 1 }, () => file)),
    ).toBe(false);
  });
});
