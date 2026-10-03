import { describe, expect, it } from "vitest";
import {
  REVISION_DIFF_MAX_PATHS,
  revisionDiffGet,
} from "./forge.revision.diff.get";

describe("get_revision_diff contract", () => {
  it("is a read every workspace role may make", () => {
    expect(revisionDiffGet.name).toBe("get_revision_diff");
    expect(revisionDiffGet.mutates).toBe(false);
    expect(revisionDiffGet.defaultRoles.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
      Viewer: "allow",
    });
  });

  it("takes a revision id and at most the path cap (negative past it)", () => {
    expect(revisionDiffGet.input.safeParse({ revisionId: "prv_1" }).success).toBe(true);
    expect(revisionDiffGet.input.safeParse({ revisionId: "fpr_1" }).success).toBe(false);
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);
    expect(
      revisionDiffGet.input.safeParse({ revisionId: "prv_1", paths: paths(REVISION_DIFF_MAX_PATHS) }).success,
    ).toBe(true);
    expect(
      revisionDiffGet.input.safeParse({ revisionId: "prv_1", paths: paths(REVISION_DIFF_MAX_PATHS + 1) }).success,
    ).toBe(false);
  });
});
