import { describe, it, expect } from "vitest";
import {
  normalizeTouchPath,
  recordTouch,
  hydrateTouchedFiles,
  createPackageResolver,
  type TouchedFile,
  type PackageResolverFs,
} from "../files-touched.js";
import type { ChangedFile } from "../git-diff.js";

const ROOT = "/repo";

function entry(
  path: string,
  ops: TouchedFile["ops"],
  firstSeq = 1,
): TouchedFile {
  return { path, ops, firstSeq };
}

describe("normalizeTouchPath", () => {
  it("makes absolute paths inside the root repo-relative", () => {
    expect(normalizeTouchPath("/repo/src/a.ts", ROOT)).toBe("src/a.ts");
  });

  it("keeps absolute paths outside the root absolute", () => {
    expect(normalizeTouchPath("/elsewhere/b.ts", ROOT)).toBe("/elsewhere/b.ts");
  });

  it("strips a leading ./", () => {
    expect(normalizeTouchPath("./src/a.ts", ROOT)).toBe("src/a.ts");
  });
});

describe("recordTouch", () => {
  it("creates an entry on first touch and dedupes repeat ops", () => {
    const map = new Map<string, TouchedFile>();
    recordTouch(map, "src/a.ts", "R", ROOT, 1);
    recordTouch(map, "/repo/src/a.ts", "R", ROOT, 2);
    expect(map.size).toBe(1);
    const got = map.get("src/a.ts")!;
    expect(got.ops).toEqual(["R"]);
    expect(got.firstSeq).toBe(1);
  });

  it("keeps ops in C,R,U,D display order regardless of arrival order", () => {
    const map = new Map<string, TouchedFile>();
    recordTouch(map, "src/a.ts", "U", ROOT, 1);
    recordTouch(map, "src/a.ts", "C", ROOT, 2);
    recordTouch(map, "src/a.ts", "R", ROOT, 3);
    expect(map.get("src/a.ts")!.ops).toEqual(["C", "R", "U"]);
  });

  it("ignores empty paths", () => {
    const map = new Map<string, TouchedFile>();
    recordTouch(map, "  ", "R", ROOT, 1);
    expect(map.size).toBe(0);
  });
});

describe("hydrateTouchedFiles", () => {
  const io = { fileExists: () => true };

  it("joins +/- counts and git status from the changed-file list", () => {
    const changed: ChangedFile[] = [
      {
        path: "src/a.ts",
        status: "M",
        untracked: false,
        insertions: 100,
        deletions: 44,
      },
    ];
    const [row] = hydrateTouchedFiles([entry("src/a.ts", ["U"])], changed, io);
    expect(row).toMatchObject({
      insertions: 100,
      deletions: 44,
      gitStatus: "M",
      untracked: false,
    });
  });

  it("falls back to a whole-file line count for untracked creates", () => {
    const changed: ChangedFile[] = [
      { path: "src/new.ts", status: "?", untracked: true },
    ];
    const [row] = hydrateTouchedFiles([entry("src/new.ts", ["C"])], changed, {
      fileExists: () => true,
      countLines: () => 12,
    });
    expect(row!.insertions).toBe(12);
    expect(row!.deletions).toBe(0);
  });

  it("adds the D op when git reports the file deleted", () => {
    const changed: ChangedFile[] = [
      { path: "src/gone.ts", status: "D", untracked: false, deletions: 30 },
    ];
    const [row] = hydrateTouchedFiles(
      [entry("src/gone.ts", ["U"])],
      changed,
      io,
    );
    expect(row!.ops).toEqual(["U", "D"]);
  });

  it("adds the D op when a written file has vanished from disk", () => {
    const [row] = hydrateTouchedFiles([entry("src/tmp.ts", ["C"])], [], {
      fileExists: () => false,
    });
    expect(row!.ops).toEqual(["C", "D"]);
  });

  it("does NOT mark read-only touches deleted just because git is clean", () => {
    const [row] = hydrateTouchedFiles([entry("src/read.ts", ["R"])], [], {
      fileExists: () => false, // even a bad probe must not imply deletion
    });
    expect(row!.ops).toEqual(["R"]);
    expect(row!.insertions).toBeUndefined();
  });

  it("orders rows by first touch", () => {
    const rows = hydrateTouchedFiles(
      [entry("b.ts", ["U"], 5), entry("a.ts", ["R"], 2)],
      [],
      io,
    );
    expect(rows.map((r) => r.path)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("createPackageResolver", () => {
  const fakeFs: PackageResolverFs = {
    exists: (p) =>
      p === "/repo/apps/app/package.json" ||
      p === "/repo/packages/foo/package.json" ||
      p === "/repo/package.json",
    readPackageName: (p) => {
      if (p === "/repo/apps/app/package.json") return "@oxagen/app";
      if (p === "/repo/packages/foo/package.json") return "@oxagen/foo";
      if (p === "/repo/package.json") return "oxagen-monorepo";
      return undefined;
    },
  };

  it("labels a file with its nearest package and strips the src/ prefix", () => {
    const resolve = createPackageResolver(ROOT, fakeFs);
    expect(resolve("apps/app/src/components/thing.tsx")).toEqual({
      pkg: "@oxagen/app",
      display: "components/thing.tsx",
    });
  });

  it("keeps non-src package paths package-relative", () => {
    const resolve = createPackageResolver(ROOT, fakeFs);
    expect(resolve("packages/foo/lib/util.ts")).toEqual({
      pkg: "@oxagen/foo",
      display: "lib/util.ts",
    });
  });

  it("never labels with the monorepo root package", () => {
    const resolve = createPackageResolver(ROOT, fakeFs);
    expect(resolve("README.md")).toEqual({ display: "README.md" });
    expect(resolve("tools/scripts/x.ts")).toEqual({
      display: "tools/scripts/x.ts",
    });
  });

  it("passes absolute (outside-root) paths through unlabelled", () => {
    const resolve = createPackageResolver(ROOT, fakeFs);
    expect(resolve("/elsewhere/b.ts")).toEqual({ display: "/elsewhere/b.ts" });
  });
});
