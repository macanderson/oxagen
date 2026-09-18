import { describe, expect, it } from "vitest";
import {
  languageOf,
  repoRelativePathOf,
  worktreeRootOf,
} from "./file-facts";

describe("worktreeRootOf", () => {
  it("prefers the worktree over the project directory", () => {
    expect(
      worktreeRootOf([
        { project_dir: "/repo/packages/tacho", worktree_path: "/repo" },
      ]),
    ).toBe("/repo");
  });

  it("takes a worktree from a later event over an earlier project dir", () => {
    expect(
      worktreeRootOf([
        { project_dir: "/repo/packages/tacho" },
        { worktree_path: "/repo" },
      ]),
    ).toBe("/repo");
  });

  it("falls back to the project directory when no worktree is reported", () => {
    expect(worktreeRootOf([{ project_dir: "/repo" }, undefined])).toBe("/repo");
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
