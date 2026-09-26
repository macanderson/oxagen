import {
  chmodSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  datedNow,
  pushUpstream,
  removeRigs,
  rig,
} from "./git-rig.test-support";
import { readPreexistingPaths, readSessionChanges } from "./session-changes";
import {
  readWorktreeSnapshot,
  relabelPreSessionPatch,
  safeRepositoryUrl,
  WORKTREE_PATCH_MAX_BYTES,
} from "./worktree-snapshot";

afterEach(removeRigs);

/** The paths a patch names in its `diff --git` lines, in order. */
function patched(patch: string | undefined): string[] {
  return [...(patch ?? "").matchAll(/^diff --git a\/(.*) b\//gm)].map(
    (match) => match[1] ?? "",
  );
}

/** The added and removed lines of a patch, without the file headers. */
function hunkLines(patch: string | undefined): string[] {
  return (patch ?? "")
    .split("\n")
    .filter(
      (line) =>
        /^[+-]/.test(line) &&
        !line.startsWith("+++") &&
        !line.startsWith("---"),
    );
}

describe("the patch beside a session-basis reconciliation", () => {
  it("takes an uncommitted edit against HEAD, as its row counts it, after a pull changed the same file", async () => {
    const r = rig();
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const baseline = r.git(r.work, ["rev-parse", "HEAD"]).trim();
    const start = {
      baseline,
      firstReadAt: startedAt,
      preexisting: await readPreexistingPaths(r.exec, r.work, startedAt),
    };
    // Someone else changes shared.txt upstream, and the session pulls it.
    pushUpstream(r);
    r.git(r.work, ["pull", "-q", "--ff-only", "origin", "main"]);
    // The session edits the same file and does not commit.
    writeFileSync(
      join(r.work, "shared.txt"),
      "shared\nupstream line\nsession line\n",
    );

    const reading = await readSessionChanges(r.exec, r.work, start);
    expect(reading?.changes).toMatchObject([
      { repo_relative_path: "shared.txt", lines_added: 1, lines_removed: 0 },
    ]);
    const snapshot = await readWorktreeSnapshot(
      r.exec,
      r.work,
      baseline,
      reading?.measured,
    );
    expect(patched(snapshot?.patch)).toEqual(["shared.txt"]);
    // One added line, as the row counts. The upstream hunk is not in it.
    expect(hunkLines(snapshot?.patch)).toEqual(["+session line"]);
    // So the patch is not a diff from the baseline the frame names, and says
    // so.
    expect(snapshot?.limitations).toEqual(["mixed_bases"]);
    expect(snapshot?.complete).toBe(false);
  });

  it("takes a file that already held edits against what it held then, as its row counts it", async () => {
    const r = rig();
    // A person's uncommitted edits, from before the session started.
    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nperson\n");
    writeFileSync(join(r.work, "notes.txt"), "a draft\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const baseline = r.git(r.work, ["rev-parse", "HEAD"]).trim();
    const copies = join(r.root, "tacho", "pre-session", "session");
    const start = {
      baseline,
      firstReadAt: startedAt,
      preexisting: await readPreexistingPaths(r.exec, r.work, startedAt, {
        dir: copies,
        capBytes: 1024,
      }),
    };
    // The session adds a line to one and deletes the other.
    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nperson\nsession\n");
    unlinkSync(join(r.work, "notes.txt"));

    const reading = await readSessionChanges(r.exec, r.work, start, copies);
    expect(reading?.changes).toMatchObject([
      { repo_relative_path: "a.txt", lines_added: 1, lines_removed: 0 },
      { repo_relative_path: "notes.txt", status: "deleted", lines_removed: 1 },
    ]);
    const snapshot = await readWorktreeSnapshot(
      r.exec,
      r.work,
      baseline,
      reading?.measured,
    );
    expect(patched(snapshot?.patch)).toEqual(["a.txt", "notes.txt"]);
    // The session's line and the draft it deleted. Not the person's line.
    expect(hunkLines(snapshot?.patch)).toEqual(["+session", "-a draft"]);
    expect(snapshot?.patch).toContain("--- a/notes.txt\n+++ /dev/null\n");
    // The copies' directory never reaches the record.
    expect(snapshot?.patch).not.toContain(copies.slice(1));
    expect(snapshot?.bases).toEqual({
      head_ref: r.git(r.work, ["rev-parse", "HEAD"]).trim(),
      baseline_paths: [],
      pre_session_paths: ["a.txt", "notes.txt"],
    });
    expect(snapshot?.limitations).toEqual(["mixed_bases"]);
  });

  it("claims no mode change for an executable file that already held edits", async () => {
    const r = rig();
    writeFileSync(join(r.work, "run.sh"), "#!/bin/sh\necho one\n");
    chmodSync(join(r.work, "run.sh"), 0o755);
    r.git(r.work, ["add", "."]);
    r.git(r.work, ["commit", "-q", "-m", "script"], datedNow());
    // A person's edit to the script and an untracked executable, both from
    // before the session.
    writeFileSync(join(r.work, "run.sh"), "#!/bin/sh\necho one\necho person\n");
    writeFileSync(join(r.work, "tool.sh"), "#!/bin/sh\n");
    chmodSync(join(r.work, "tool.sh"), 0o755);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const baseline = r.git(r.work, ["rev-parse", "HEAD"]).trim();
    const copies = join(r.root, "tacho", "pre-session", "session");
    const start = {
      baseline,
      firstReadAt: startedAt,
      preexisting: await readPreexistingPaths(r.exec, r.work, startedAt, {
        dir: copies,
        capBytes: 1024,
      }),
    };
    // The session adds a line to the script and deletes the tool.
    writeFileSync(
      join(r.work, "run.sh"),
      "#!/bin/sh\necho one\necho person\necho session\n",
    );
    unlinkSync(join(r.work, "tool.sh"));

    const reading = await readSessionChanges(r.exec, r.work, start, copies);
    const snapshot = await readWorktreeSnapshot(
      r.exec,
      r.work,
      baseline,
      reading?.measured,
    );
    expect(patched(snapshot?.patch)).toEqual(["run.sh", "tool.sh"]);
    expect(hunkLines(snapshot?.patch)).toEqual(["+echo session", "-#!/bin/sh"]);
    expect(snapshot?.patch).not.toMatch(/^(?:old|new) mode /m);
    expect(snapshot?.patch).toContain("deleted file mode 100755\n");
  });

  it("spawns no diff for a file that already held edits once the patch is full", async () => {
    const r = rig();
    writeFileSync(join(r.work, "big.txt"), "");
    r.git(r.work, ["add", "."]);
    r.git(r.work, ["commit", "-q", "-m", "empty"], datedNow());
    writeFileSync(
      join(r.work, "big.txt"),
      "x".repeat(WORKTREE_PATCH_MAX_BYTES + 1024),
    );
    writeFileSync(join(r.work, "late.txt"), "written again\n");
    const head = r.git(r.work, ["rev-parse", "HEAD"]).trim();
    const noIndex: string[][] = [];
    const exec: typeof r.exec = (command, args) => {
      if (args.includes("--no-index")) noIndex.push(args);
      return r.exec(command, args);
    };
    const snapshot = await readWorktreeSnapshot(exec, r.work, head, {
      headRef: head,
      fromBaseline: [],
      fromHead: ["big.txt"],
      fromPreSession: [{ path: "late.txt", copy: null }],
    });
    expect(snapshot?.limitations).toContain("patch_size_limit");
    expect(noIndex).toEqual([]);
  });

  it("takes a path the session committed against the baseline, as its row counts it", async () => {
    const r = rig();
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const baseline = r.git(r.work, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(r.work, "mine.txt"), "one\n");
    r.git(r.work, ["add", "."]);
    r.git(r.work, ["commit", "-q", "-m", "session work"], datedNow());
    // More on the same file, uncommitted, and a new untracked file.
    writeFileSync(join(r.work, "mine.txt"), "one\ntwo\n");
    writeFileSync(join(r.work, "new.txt"), "new\n");

    const reading = await readSessionChanges(r.exec, r.work, {
      baseline,
      firstReadAt: startedAt,
    });
    expect(reading?.changes).toMatchObject([
      { repo_relative_path: "mine.txt", lines_added: 2 },
      { repo_relative_path: "new.txt", lines_added: 1 },
    ]);
    const snapshot = await readWorktreeSnapshot(
      r.exec,
      r.work,
      baseline,
      reading?.measured,
    );
    expect(patched(snapshot?.patch)).toEqual(["mine.txt", "new.txt"]);
    expect(hunkLines(snapshot?.patch)).toEqual(["+one", "+two", "+new"]);
    // HEAD moved, and no commit since the baseline changed new.txt, so its
    // hunk is what the baseline would give.
    expect(snapshot?.limitations).toEqual([]);
  });
});

it.each([
  [
    "https://user:secret@github.com/acme/repo.git?token=secret#key",
    "https://github.com/acme/repo",
  ],
  ["https://github.com/acme/repo.git", "https://github.com/acme/repo"],
  ["http://gitlab.example/acme/repo", "https://gitlab.example/acme/repo"],
  ["git@github.com:acme/repo.git", "https://github.com/acme/repo"],
  [
    "ssh://git@gitlab.example/acme/nested/repo.git",
    "https://gitlab.example/acme/nested/repo",
  ],
  ["file:///tmp/private", null],
  ["/tmp/private", null],
  ["https://github.com/acme/repo%0Asecret", null],
])(
  "sanitizes remote %s without retaining authentication",
  (remote, expected) => {
    expect(safeRepositoryUrl(remote)).toBe(expected);
  },
);

function fake(patch: string, moving = false) {
  let heads = 0;
  return vi.fn(async (_command: string, args: string[]) => {
    let stdout = "";
    if (args.includes("--show-toplevel")) stdout = "/repo\n";
    else if (args.includes("rev-parse"))
      stdout = (moving && heads++ > 0 ? "b" : "a").repeat(40);
    else if (args.includes("remote"))
      stdout = "https://token@github.com/acme/repo.git";
    else if (args.includes("ls-files")) stdout = "";
    // No commit between the baseline and HEAD changed a reported path.
    else if (args.includes("--name-only")) stdout = "";
    else if (args.includes("diff")) stdout = patch;
    return { status: 0, stdout, stderr: "" };
  });
}

describe("worktree snapshots", () => {
  it("keeps the fixed baseline and disables repository diff programs", async () => {
    const exec = fake("diff --git a/file b/file\n+actual output\n");
    const result = await readWorktreeSnapshot(exec, "/repo", "c".repeat(40));
    expect(result).toMatchObject({
      baseline: "c".repeat(40),
      head: "a".repeat(40),
      complete: true,
      repository: "https://github.com/acme/repo",
    });
    const diff = exec.mock.calls.find(([, args]) => args.includes("diff"));
    expect(diff?.[1]).toEqual(
      expect.arrayContaining([
        "--no-ext-diff",
        "--no-textconv",
        "c".repeat(40),
        "--",
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("token");
  });
  it("marks a bounded patch and a moving head partial", async () => {
    const result = await readWorktreeSnapshot(
      fake("x".repeat(WORKTREE_PATCH_MAX_BYTES + 10), true),
      "/repo",
    );
    expect(result?.patch.length).toBe(WORKTREE_PATCH_MAX_BYTES);
    expect(result?.complete).toBe(false);
    expect(result?.limitations).toEqual(
      expect.arrayContaining([
        "patch_size_limit",
        "head_changed_during_capture",
      ]),
    );
  });
  it("patches only the paths the reconciliation reports", async () => {
    // After a pull, the whole diff from the baseline carries every upstream
    // file. The patch beside a reconciliation describes the rows in it.
    const underlying = fake("diff --git a/mine.ts b/mine.ts\n+mine\n");
    const exec = vi.fn(async (command: string, args: string[]) =>
      args.includes("ls-files")
        ? { status: 0, stdout: "new.ts\0upstream-new.ts\0", stderr: "" }
        : underlying(command, args),
    );
    const result = await readWorktreeSnapshot(exec, "/repo", "c".repeat(40), {
      headRef: "a".repeat(40),
      fromBaseline: ["mine.ts"],
      fromHead: ["new.ts", "odd*name.ts"],
      fromPreSession: [],
    });
    const diffs = exec.mock.calls
      .map(([, args]) => args)
      .filter((args) => args.includes("diff") && !args.includes("--name-only"));
    // The committed path against the baseline, the rest against HEAD.
    expect(diffs[0]?.slice(diffs[0].indexOf("--") - 1)).toEqual([
      "c".repeat(40),
      "--",
      ":(literal)mine.ts",
    ]);
    expect(diffs[1]?.slice(diffs[1].indexOf("--") - 1)).toEqual([
      "a".repeat(40),
      "--",
      ":(literal)new.ts",
      ":(literal)odd*name.ts",
    ]);
    // Of the two untracked files, only the reported one is patched.
    expect(diffs.slice(2).map((args) => args.at(-1))).toEqual(["new.ts"]);
    expect(result?.bases).toEqual({
      head_ref: "a".repeat(40),
      baseline_paths: ["mine.ts"],
      pre_session_paths: [],
    });
    expect(result?.complete).toBe(true);
  });
  it("patches no tracked file when the reconciliation reports none", async () => {
    const exec = fake("diff --git a/upstream.ts b/upstream.ts\n");
    const result = await readWorktreeSnapshot(exec, "/repo", "c".repeat(40), {
      headRef: "a".repeat(40),
      fromBaseline: [],
      fromHead: [],
      fromPreSession: [],
    });
    expect(result?.patch).toBe("");
    expect(exec.mock.calls.some(([, args]) => args.includes("diff"))).toBe(
      false,
    );
  });
  it("marks the patch partial when HEAD moved after the reconciliation read it", async () => {
    const result = await readWorktreeSnapshot(
      fake("diff --git a/a b/a\n"),
      "/repo",
      "c".repeat(40),
      {
        headRef: "d".repeat(40),
        fromBaseline: [],
        fromHead: ["a"],
        fromPreSession: [],
      },
    );
    expect(result?.limitations).toEqual(["head_changed_during_capture"]);
  });
  it("marks a patch whose HEAD hunk a pulled commit changed as mixed", async () => {
    const underlying = fake("diff --git a/a b/a\n");
    const exec = vi.fn(async (command: string, args: string[]) =>
      args.includes("--name-only")
        ? { status: 0, stdout: "a\0", stderr: "" }
        : underlying(command, args),
    );
    const result = await readWorktreeSnapshot(exec, "/repo", "c".repeat(40), {
      headRef: "a".repeat(40),
      fromBaseline: [],
      fromHead: ["a", "b"],
      fromPreSession: [],
    });
    expect(result?.limitations).toEqual(["mixed_bases"]);
    // Only the paths taken against HEAD are compared, between the two commits.
    const compared = exec.mock.calls
      .map(([, args]) => args)
      .find((args) => args.includes("--name-only"));
    expect(compared?.slice(compared.indexOf("--name-only") + 3)).toEqual([
      "c".repeat(40),
      "a".repeat(40),
      "--",
      ":(literal)a",
      ":(literal)b",
    ]);
  });
  it("names a pre-session hunk by its path, quoted where git quotes it", () => {
    const raw = [
      'diff --git a/state/pre-session/s/0123 b/odd"name.txt',
      "index 94b3599..00c1a01 100644",
      "--- a/state/pre-session/s/0123",
      '+++ "b/odd\\"name.txt"',
      "@@ -1 +1,2 @@",
      " one",
      "+two",
      "",
    ].join("\n");
    expect(
      relabelPreSessionPatch(raw, 'odd"name.txt', {
        before: true,
        after: true,
      }).split("\n"),
    ).toEqual([
      'diff --git "a/odd\\"name.txt" "b/odd\\"name.txt"',
      "index 94b3599..00c1a01 100644",
      '--- "a/odd\\"name.txt"',
      '+++ "b/odd\\"name.txt"',
      "@@ -1 +1,2 @@",
      " one",
      "+two",
      "",
    ]);
    expect(
      relabelPreSessionPatch(
        "diff --git a/state/x b/bin.dat\nindex 1..2 100644\nBinary files a/state/x and b/bin.dat differ\n",
        "bin.dat",
        { before: true, after: true },
      ),
    ).toBe(
      "diff --git a/bin.dat b/bin.dat\nindex 1..2 100644\nBinary files a/bin.dat and b/bin.dat differ\n",
    );
  });
  it("returns no invented snapshot when git cannot read the directory", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("git unavailable"));
    expect(await readWorktreeSnapshot(exec, "/missing")).toBeUndefined();
  });
});

it("reads repository-wide evidence from the resolved root when a session starts in a subdirectory", async () => {
  const exec = fake("diff");
  await readWorktreeSnapshot(exec, "/repo/nested");
  expect(exec.mock.calls[0]?.[1]).toEqual(
    expect.arrayContaining(["-C", "/repo/nested", "--show-toplevel"]),
  );
  for (const [, args] of exec.mock.calls.slice(1))
    expect(args.slice(0, 2)).toEqual(["-C", "/repo"]);
});
it("reports omitted untracked patches when tracked bytes exactly exhaust the cap", async () => {
  const underlying = fake("x".repeat(WORKTREE_PATCH_MAX_BYTES));
  const exec = vi.fn(async (command: string, args: string[]) =>
    args.includes("ls-files")
      ? { status: 0, stdout: "untracked.ts\0", stderr: "" }
      : underlying(command, args),
  );
  const result = await readWorktreeSnapshot(exec, "/repo");
  expect(result).toMatchObject({
    complete: false,
    limitations: ["untracked_content_omitted"],
  });
});

describe("worktree changes during capture", () => {
  it("marks the snapshot partial when the changed-path set moves between reads", async () => {
    const underlying = fake("diff --git a/a b/a\n");
    let statuses = 0;
    const exec = vi.fn(async (command: string, args: string[]) =>
      args.includes("status")
        ? {
            status: 0,
            stdout: statuses++ === 0 ? "" : "? formatter-output.ts\0",
            stderr: "",
          }
        : underlying(command, args),
    );
    const result = await readWorktreeSnapshot(exec, "/repo");
    expect(result).toMatchObject({
      complete: false,
      limitations: ["worktree_changed_during_capture"],
    });
  });

  it("marks the snapshot partial when an already modified file is edited again mid-capture", async () => {
    const root = mkdtempSync(join(tmpdir(), "tacho-worktree-"));
    try {
      const file = join(root, "src.ts");
      writeFileSync(file, "one\n");
      const record = "1 .M N... 100644 100644 100644 aaa bbb src.ts\0";
      const exec = vi.fn(async (_command: string, args: string[]) => {
        let stdout = "";
        if (args.includes("--show-toplevel")) stdout = `${root}\n`;
        else if (args.includes("rev-parse")) stdout = "a".repeat(40);
        else if (args.includes("status")) stdout = record;
        else if (args.includes("diff")) {
          // A formatter rewrites the file while the diff is being read: the
          // status record is unchanged, only the file's bytes and times move.
          writeFileSync(file, "one\ntwo\nthree\n");
          utimesSync(file, new Date(), new Date(Date.now() + 5_000));
          stdout = "diff --git a/src.ts b/src.ts\n";
        }
        return { status: 0, stdout, stderr: "" };
      });
      const result = await readWorktreeSnapshot(exec, root);
      expect(result?.complete).toBe(false);
      expect(result?.limitations).toContain("worktree_changed_during_capture");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a still worktree complete", async () => {
    const underlying = fake("diff --git a/a b/a\n");
    const exec = vi.fn(async (command: string, args: string[]) =>
      args.includes("status")
        ? { status: 0, stdout: "? stable.ts\0", stderr: "" }
        : underlying(command, args),
    );
    const result = await readWorktreeSnapshot(exec, "/repo");
    expect(result).toMatchObject({ complete: true, limitations: [] });
  });

  it("does not claim a stable tree when the state cannot be read", async () => {
    const underlying = fake("diff --git a/a b/a\n");
    const exec = vi.fn(async (command: string, args: string[]) =>
      args.includes("status")
        ? { status: 128, stdout: "", stderr: "fatal" }
        : underlying(command, args),
    );
    const result = await readWorktreeSnapshot(exec, "/repo");
    expect(result).toMatchObject({
      complete: false,
      limitations: ["worktree_state_unverified"],
    });
  });
});
