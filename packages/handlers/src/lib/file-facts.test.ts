import { describe, expect, it } from "vitest";
import {
  languageOf,
  observedChangesOf,
  repoRelativePathOf,
  worktreeRootOf,
} from "./file-facts";

describe("worktreeRootOf", () => {
  it("reads the worktree a batch names", () => {
    expect(worktreeRootOf([{ worktree_path: "/repo" }])).toBe("/repo");
  });

  it("takes the worktree from a later event when the first names none", () => {
    expect(worktreeRootOf([{}, { worktree_path: "/repo" }])).toBe("/repo");
  });

  it("names no root from a project directory alone", () => {
    // `project_dir` is where the agent was pointed, which in a monorepo is a
    // package. Stripping it would leave every package's `src/x.ts` looking
    // like the same file, so the field stays null instead.
    // Typed as a context rather than as a bare literal: the parameter names
    // `worktree_path` only, and a fresh literal that shares none of its
    // members is an excess-property error rather than the case under test.
    const contexts: readonly (
      | { worktree_path?: string; project_dir?: string }
      | undefined
    )[] = [{ project_dir: "/repo/packages/tacho" }, undefined];
    expect(worktreeRootOf(contexts)).toBeUndefined();
    expect(
      repoRelativePathOf("/repo/packages/tacho/src/x.ts", undefined),
    ).toBeUndefined();
  });

  it("keeps two same-named files in different packages distinct", () => {
    const root = worktreeRootOf([{ worktree_path: "/repo" }]);
    expect(repoRelativePathOf("/repo/packages/a/src/x.ts", root)).toBe(
      "packages/a/src/x.ts",
    );
    expect(repoRelativePathOf("/repo/packages/b/src/x.ts", root)).toBe(
      "packages/b/src/x.ts",
    );
  });

  it("strips trailing separators", () => {
    expect(worktreeRootOf([{ worktree_path: "/repo//" }])).toBe("/repo");
  });

  it("keeps the filesystem root intact", () => {
    expect(worktreeRootOf([{ worktree_path: "/" }])).toBe("/");
  });

  it("returns undefined when nothing names a place", () => {
    expect(worktreeRootOf([undefined, {}])).toBeUndefined();
  });
});

describe("repoRelativePathOf", () => {
  it("strips the worktree root", () => {
    expect(repoRelativePathOf("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
  });

  it("refuses a sibling directory sharing the root's prefix", () => {
    expect(repoRelativePathOf("/repo-brand/src/a.ts", "/repo")).toBeUndefined();
  });

  it("refuses a path outside the worktree", () => {
    expect(repoRelativePathOf("/etc/passwd", "/repo")).toBeUndefined();
  });

  it("refuses the root itself, which is not a file", () => {
    expect(repoRelativePathOf("/repo", "/repo")).toBeUndefined();
  });

  it("returns an already relative path unchanged", () => {
    expect(repoRelativePathOf("src/a.ts", undefined)).toBe("src/a.ts");
  });

  it("returns undefined for an absolute path with no known root", () => {
    expect(repoRelativePathOf("/repo/src/a.ts", undefined)).toBeUndefined();
  });

  it("handles a worktree at the filesystem root", () => {
    expect(repoRelativePathOf("/a.ts", "/")).toBe("a.ts");
  });

  it("returns undefined for an empty path", () => {
    expect(repoRelativePathOf("", "/repo")).toBeUndefined();
  });

  it("strips a Windows root off a Windows path", () => {
    expect(
      repoRelativePathOf("C:\\repo\\src\\a.ts", "C:\\repo"),
    ).toBe("src/a.ts");
  });

  it("matches a Windows root whatever case the drive letter carries", () => {
    expect(repoRelativePathOf("c:\\repo\\src\\a.ts", "C:/repo")).toBe(
      "src/a.ts",
    );
  });

  it("strips a UNC share root", () => {
    expect(
      repoRelativePathOf(
        "\\\\server\\share\\src\\a.ts",
        "\\\\server\\share",
      ),
    ).toBe("src/a.ts");
  });

  it("refuses a Windows path with no known root", () => {
    // The whole point of the column is to read the same on every host, and a
    // drive letter is the opposite of that.
    expect(
      repoRelativePathOf("C:\\repo\\src\\a.ts", undefined),
    ).toBeUndefined();
  });

  it("refuses a Windows path outside the root", () => {
    expect(
      repoRelativePathOf("D:\\other\\src\\a.ts", "C:\\repo"),
    ).toBeUndefined();
  });

  it("returns an already relative Windows path unchanged", () => {
    // Nothing to strip, so it is returned as it arrived.
    expect(repoRelativePathOf("src\\a.ts", undefined)).toBe("src\\a.ts");
  });
});

describe("languageOf", () => {
  it("reads the extension", () => {
    expect(languageOf("/repo/src/a.tsx")).toBe("typescript");
    expect(languageOf("/repo/src/a.py")).toBe("python");
    expect(languageOf("/repo/go.mod")).toBeUndefined();
  });

  it("is case insensitive", () => {
    expect(languageOf("/repo/README.MD")).toBe("markdown");
  });

  it("names a file that has no extension", () => {
    expect(languageOf("/repo/Dockerfile")).toBe("dockerfile");
    expect(languageOf("/repo/Makefile")).toBe("make");
  });

  it("does not read a dotfile's name as an extension", () => {
    expect(languageOf("/repo/.gitignore")).toBeUndefined();
  });

  it("reads the last extension of a compound name", () => {
    expect(languageOf("/repo/a.test.ts")).toBe("typescript");
  });

  it("returns undefined for an unknown extension", () => {
    expect(languageOf("/repo/a.xyz")).toBeUndefined();
  });

  it("returns undefined for a path ending in a separator", () => {
    expect(languageOf("/repo/src/")).toBeUndefined();
  });
});

describe("observedChangesOf", () => {
  const change = {
    path: "/repo/src/a.ts",
    repo_relative_path: "src/a.ts",
    status: "modified",
    lines_added: 4,
    lines_removed: 1,
  };

  it("reads the list a reconciliation frame carries", () => {
    expect(observedChangesOf({ observed_changes: [change] })).toEqual([change]);
  });

  it("reads nothing from a body that carries no list", () => {
    expect(observedChangesOf({})).toEqual([]);
    expect(observedChangesOf(undefined)).toEqual([]);
    expect(observedChangesOf({ observed_changes: "all of them" })).toEqual([]);
  });

  it("skips a row of the wrong shape rather than half-writing it", () => {
    const rows = observedChangesOf({
      observed_changes: [
        { ...change, lines_added: "four" },
        { ...change, path: "" },
        change,
      ],
    });
    expect(rows).toEqual([change]);
  });

  it("keeps a row whose repo-relative path is missing", () => {
    const rows = observedChangesOf({
      observed_changes: [{ ...change, repo_relative_path: undefined }],
    });
    expect(rows[0]?.repo_relative_path).toBe("");
    expect(rows[0]?.path).toBe("/repo/src/a.ts");
  });
});
