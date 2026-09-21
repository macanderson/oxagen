import { describe, expect, it } from "vitest";
import {
  fileIdentityOf,
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

  it("refuses a path whose dot segments climb out of the worktree", () => {
    // `/repo/../shared/config.ts` starts with `/repo/` as a string but
    // resolves to `/shared/config.ts`. Reported as `../shared/config.ts` it
    // would attribute an external file to this repository and collide with a
    // genuine relative path in the same column.
    expect(
      repoRelativePathOf("/repo/../shared/config.ts", "/repo"),
    ).toBeUndefined();
  });

  it("keeps a path whose dot segments stay inside the worktree", () => {
    expect(repoRelativePathOf("/repo/packages/../src/a.ts", "/repo")).toBe(
      "src/a.ts",
    );
    expect(repoRelativePathOf("/repo/./src/a.ts", "/repo")).toBe("src/a.ts");
  });

  it("refuses a sibling reached through the root's own dot segments", () => {
    // The sibling-prefix trap with a non-normalized root on both sides: a
    // naive prefix test passes `/repo-other/x.ts` under `/repo`, and dot
    // segments must not smuggle it back in either.
    expect(repoRelativePathOf("/repo-other/x.ts", "/repo")).toBeUndefined();
    expect(
      repoRelativePathOf("/repo/../repo-other/x.ts", "/repo/."),
    ).toBeUndefined();
  });

  it("measures against a root that carries its own dot segments", () => {
    expect(repoRelativePathOf("/repo/src/a.ts", "/repo/packages/..")).toBe(
      "src/a.ts",
    );
  });

  it("refuses a relative path that climbs above the worktree", () => {
    expect(repoRelativePathOf("../shared/config.ts", "/repo")).toBeUndefined();
    expect(
      repoRelativePathOf("../shared/config.ts", undefined),
    ).toBeUndefined();
  });

  it("refuses a path outside the worktree", () => {
    expect(repoRelativePathOf("/etc/passwd", "/repo")).toBeUndefined();
  });

  it("refuses the root itself, which is not a file", () => {
    expect(repoRelativePathOf("/repo", "/repo")).toBeUndefined();
  });

  it("leaves repository identity unknown for an unplaced relative path", () => {
    expect(repoRelativePathOf("src/a.ts", undefined)).toBeUndefined();
    expect(repoRelativePathOf("src/a.ts", "/repo")).toBe("src/a.ts");
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
    expect(repoRelativePathOf("C:\\repo\\src\\a.ts", "C:\\repo")).toBe(
      "src/a.ts",
    );
  });

  it("matches a Windows root whatever case the drive letter carries", () => {
    expect(repoRelativePathOf("c:\\repo\\src\\a.ts", "C:/repo")).toBe(
      "src/a.ts",
    );
  });

  it("matches a Windows root whose case differs past the drive letter", () => {
    // NTFS compares filenames without case and records them with it, so one
    // tool's `c:\\Repo` and a git read's `C:\\repo` are the same directory.
    // Folding only the drive letter left everything below it unmatched, and
    // the file landed in a second row under its absolute path.
    expect(repoRelativePathOf("c:\\Repo\\src\\a.ts", "C:\\repo")).toBe(
      "src/a.ts",
    );
    // The spelling that comes back is the one that arrived, not the folded
    // form: the comparison is case-insensitive, the record is not.
    expect(repoRelativePathOf("C:\\repo\\SRC\\A.ts", "c:\\REPO")).toBe(
      "SRC/A.ts",
    );
  });

  it("keeps case significant on a POSIX root, where it names the file", () => {
    // The mirror of the case above: on ext4 `/repo/SRC` and `/repo/src` are
    // two directories, so a path under one is not under the other.
    expect(repoRelativePathOf("/REPO/src/a.ts", "/repo")).toBeUndefined();
  });

  it("strips a UNC share root", () => {
    expect(
      repoRelativePathOf("\\\\server\\share\\src\\a.ts", "\\\\server\\share"),
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

  it("normalizes an already relative Windows path", () => {
    // There is nothing to strip, but the separators still have to be
    // normalized. A tool on Windows reports `src\\a.ts` for the file a POSIX
    // host calls `src/a.ts`, and storing both would put two keys in a column
    // whose whole purpose is to read the same on every machine.
    expect(repoRelativePathOf("src\\a.ts", "C:/repo")).toBe("src/a.ts");
    expect(repoRelativePathOf("src/a.ts", "C:/repo")).toBe("src/a.ts");
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

describe("fileIdentityOf", () => {
  it.each([
    ["src/a.ts", "/repo", "/repo/src/a.ts"],
    ["./src/a.ts", "/repo", "/repo/src/a.ts"],
    ["src/../src/a.ts", "/repo", "/repo/src/a.ts"],
    ["src\\a.ts", "C:\\Repo", "c:/repo/SRC/A.ts"],
    ["src\\a.ts", "\\\\server\\share", "//SERVER/share/src/a.ts"],
  ])("matches %s in %s to its absolute identity", (path, root, absolute) => {
    expect(fileIdentityOf(path, root).key).toBe(fileIdentityOf(absolute).key);
  });

  it("keeps worktrees, unplaced paths, POSIX case, and literal backslashes distinct", () => {
    expect(fileIdentityOf("src/a.ts", "/one").key).not.toBe(
      fileIdentityOf("src/a.ts", "/two").key,
    );
    expect(fileIdentityOf("src/a.ts").key).not.toBe(
      fileIdentityOf("src/a.ts", "/one").key,
    );
    expect(fileIdentityOf("/repo/A.ts").key).not.toBe(
      fileIdentityOf("/repo/a.ts").key,
    );
    expect(fileIdentityOf("src\\a.ts", "/repo").path).toBe("/repo/src\\a.ts");
    expect(fileIdentityOf("src\\a.ts", "/repo").key).not.toBe(
      fileIdentityOf("src/a.ts", "/repo").key,
    );
  });
});
