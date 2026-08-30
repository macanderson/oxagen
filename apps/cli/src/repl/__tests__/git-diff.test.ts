import { describe, it, expect, vi } from "vitest";
import {
  parseStatusPorcelain,
  parseNumstat,
  listChangedFiles,
  getFileDiff,
  type ExecFn,
  type ExecResult,
  type ChangedFile,
} from "../git-diff.js";

/** Build a `-z` porcelain record: "XY<space>path", NUL-joined by the caller. */
function rec(xy: string, path: string): string {
  return `${xy} ${path}`;
}

describe("parseStatusPorcelain", () => {
  it("parses modified (staged/unstaged/both), added, and deleted entries", () => {
    const out =
      [
        rec(" M", "src/unstaged.ts"),
        rec("M ", "src/staged.ts"),
        rec("MM", "src/both.ts"),
        rec("A ", "src/added.ts"),
        rec(" D", "src/gone.ts"),
      ].join("\0") + "\0";
    const files = parseStatusPorcelain(out);
    expect(files).toEqual<ChangedFile[]>([
      { path: "src/unstaged.ts", status: "M", untracked: false },
      { path: "src/staged.ts", status: "M", untracked: false },
      { path: "src/both.ts", status: "M", untracked: false },
      { path: "src/added.ts", status: "A", untracked: false },
      { path: "src/gone.ts", status: "D", untracked: false },
    ]);
  });

  it("parses a rename entry, consuming the paired NUL-separated original path", () => {
    // Renames put the NEW path on the status line and the OLD path in the next
    // NUL-separated field. A following untracked entry proves the OLD field was
    // consumed (not misread as its own record).
    const out =
      ["R  src/new-name.ts", "src/old-name.ts", rec("??", "junk.txt")].join(
        "\0",
      ) + "\0";
    const files = parseStatusPorcelain(out);
    expect(files).toEqual<ChangedFile[]>([
      {
        path: "src/new-name.ts",
        status: "R",
        renamedFrom: "src/old-name.ts",
        untracked: false,
      },
      { path: "junk.txt", status: "?", untracked: true },
    ]);
  });

  it("flags untracked entries and returns [] for empty output", () => {
    expect(parseStatusPorcelain("")).toEqual([]);
    const files = parseStatusPorcelain(rec("??", "new.txt") + "\0");
    expect(files).toEqual<ChangedFile[]>([
      { path: "new.txt", status: "?", untracked: true },
    ]);
  });
});

describe("parseNumstat", () => {
  it("parses normal counts", () => {
    const map = parseNumstat("3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n");
    expect(map.get("src/a.ts")).toEqual({ insertions: 3, deletions: 1 });
    expect(map.get("src/b.ts")).toEqual({ insertions: 10, deletions: 0 });
  });

  it('records binary files ("-" counts) as zero', () => {
    const map = parseNumstat("-\t-\tassets/logo.png\n");
    expect(map.get("assets/logo.png")).toEqual({ insertions: 0, deletions: 0 });
  });

  it("normalizes brace-form rename paths to the new path", () => {
    const map = parseNumstat("2\t2\tsrc/{old => new}/file.ts\n");
    expect(map.has("src/new/file.ts")).toBe(true);
    expect(map.get("src/new/file.ts")).toEqual({ insertions: 2, deletions: 2 });
  });

  it("normalizes an added-directory brace form without leaving a double slash", () => {
    const map = parseNumstat("1\t0\tsrc/{ => added}/file.ts\n");
    expect(map.has("src/added/file.ts")).toBe(true);
  });

  it("normalizes plain-form rename paths to the new path", () => {
    const map = parseNumstat("4\t5\told.ts => new.ts\n");
    expect(map.has("new.ts")).toBe(true);
    expect(map.get("new.ts")).toEqual({ insertions: 4, deletions: 5 });
  });
});

/** An ExecFn that dispatches canned output by the git subcommand it's asked to run. */
function fakeExec(handlers: {
  status?: ExecResult;
  numstat?: ExecResult | (() => Promise<ExecResult>);
  diff?: ExecResult | (() => Promise<ExecResult>);
}): ExecFn {
  return async (_file, args) => {
    const argv = [...args];
    if (argv[0] === "status")
      return handlers.status ?? { stdout: "", stderr: "" };
    if (argv[0] === "diff" && argv[1] === "--numstat") {
      const n = handlers.numstat ?? { stdout: "", stderr: "" };
      return typeof n === "function" ? n() : n;
    }
    const d = handlers.diff ?? { stdout: "", stderr: "" };
    return typeof d === "function" ? d() : d;
  };
}

describe("listChangedFiles", () => {
  it("merges numstat counts into the matching status entries and sorts untracked last", () => {
    const exec = fakeExec({
      status: {
        stdout:
          [rec(" M", "src/a.ts"), rec("??", "z-new.txt")].join("\0") + "\0",
        stderr: "",
      },
      numstat: { stdout: "3\t1\tsrc/a.ts\n", stderr: "" },
    });
    return listChangedFiles("/repo", exec).then((files) => {
      expect(files).toEqual<ChangedFile[]>([
        {
          path: "src/a.ts",
          status: "M",
          untracked: false,
          insertions: 3,
          deletions: 1,
        },
        { path: "z-new.txt", status: "?", untracked: true },
      ]);
    });
  });

  it("returns [] when git fails entirely, and tolerates a failing numstat (no HEAD)", async () => {
    const throwing: ExecFn = async () => {
      throw new Error("not a git repository");
    };
    expect(await listChangedFiles("/nope", throwing)).toEqual([]);

    // status succeeds but numstat throws (repo with no commits) — still lists files.
    const exec = fakeExec({
      status: { stdout: rec("A ", "first.ts") + "\0", stderr: "" },
      numstat: () => Promise.reject(new Error("no HEAD")),
    });
    const files = await listChangedFiles("/repo", exec);
    expect(files).toEqual<ChangedFile[]>([
      { path: "first.ts", status: "A", untracked: false },
    ]);
  });
});

describe("getFileDiff", () => {
  const tracked: ChangedFile = {
    path: "src/a.ts",
    status: "M",
    untracked: false,
  };
  const untracked: ChangedFile = {
    path: "new.ts",
    status: "?",
    untracked: true,
  };

  it("returns the diff for a tracked file (git diff HEAD)", async () => {
    const exec = fakeExec({
      diff: { stdout: "@@ -1 +1 @@\n-old\n+new\n", stderr: "" },
    });
    expect(await getFileDiff("/repo", tracked, exec)).toBe(
      "@@ -1 +1 @@\n-old\n+new\n",
    );
  });

  it("treats git diff --no-index exit code 1 (files differ) as success with stdout", async () => {
    const exec: ExecFn = vi.fn(async () => {
      const err = Object.assign(new Error("differ"), {
        code: 1,
        stdout: "+added line\n",
      });
      throw err;
    });
    expect(await getFileDiff("/repo", untracked, exec)).toBe("+added line\n");
    expect(exec).toHaveBeenCalledOnce();
  });

  it('returns "" for a non-1 error and for a tracked-diff failure', async () => {
    const nonOne: ExecFn = async () => {
      throw Object.assign(new Error("boom"), { code: 2, stdout: "ignored" });
    };
    expect(await getFileDiff("/repo", untracked, nonOne)).toBe("");

    const trackedFail: ExecFn = async () => {
      throw new Error("bad revision");
    };
    expect(await getFileDiff("/repo", tracked, trackedFail)).toBe("");
  });
});
