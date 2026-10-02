/**
 * What a session's memory recall is scoped by (`recall-hints.ts`): the
 * tools and files its tool hooks named, and the repository it runs in. The
 * hook handler's own tests (`hook-handler-recall.test.ts`) drive the same
 * helpers through real hooks. The daemon's sweep calls `forgetRecallHints`
 * directly, so the tests of it here stand for the sweep too.
 */
import { describe, expect, it, vi } from "vitest";
import { digestBytes } from "../digest";
import type { RepositoryRemote } from "./git-facts";
import {
  forgetRecallHints,
  noteRecallHints,
  RECALL_PATHS_KEPT,
  RECALL_TOOLS_KEPT,
  REPOSITORY_RETRY_FIRST_MS,
  REPOSITORY_RETRY_MAX_MS,
  type RecallHintsHolder,
  readRepository,
  recallScope,
} from "./recall-hints";

const REMOTE: RepositoryRemote = {
  remote_digest: digestBytes("github.com/acme/widgets"),
  remote_digest_folded: digestBytes("github.com/acme/widgets.folded"),
  root: "/repo",
};

const DIGESTS = [REMOTE.remote_digest, REMOTE.remote_digest_folded];

/** A session in `cwd`; `null` for one whose directory is not known. */
function session(cwd: string | null = "/repo"): RecallHintsHolder {
  // `undefined` would take the default, so `null` stands for no directory.
  return cwd === null ? {} : { cwd };
}

/** Lets every pending promise callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("noteRecallHints", () => {
  it("keeps each tool once, newest first, and at most 32", () => {
    const holder = session();
    for (let i = 0; i < RECALL_TOOLS_KEPT; i += 1)
      noteRecallHints(holder, `tool_${i}`, undefined);
    noteRecallHints(holder, "tool_0", undefined);
    noteRecallHints(holder, "tool_new", undefined);
    const tools = holder.recallHints?.tools ?? [];
    expect(tools).toHaveLength(RECALL_TOOLS_KEPT);
    expect(tools.slice(0, 3)).toEqual(["tool_new", "tool_0", "tool_31"]);
    expect(tools).not.toContain("tool_1");
  });

  it("skips a tool name that is empty or over 200 characters", () => {
    const holder = session();
    noteRecallHints(holder, "", undefined);
    noteRecallHints(holder, "t".repeat(201), undefined);
    noteRecallHints(holder, "t".repeat(200), undefined);
    noteRecallHints(holder, undefined, { file_path: "/repo/a.ts" });
    expect(holder.recallHints).toEqual({
      tools: ["t".repeat(200)],
      paths: ["/repo/a.ts"],
    });
  });

  it("notes an MCP tool as the memory names it, without Claude Code's mcp__ prefix", () => {
    const holder = session();
    noteRecallHints(holder, "mcp__github__get_issue", undefined);
    noteRecallHints(holder, "mcp__query", undefined);
    noteRecallHints(holder, "Bash", undefined);
    // The same tool from a harness that names it without the prefix is one entry.
    noteRecallHints(holder, "github__get_issue", undefined);
    expect(holder.recallHints?.tools).toEqual([
      "github__get_issue",
      "Bash",
      "mcp__query",
    ]);
  });

  it("reads a file from file_path, path, and notebook_path only", () => {
    const holder = session();
    noteRecallHints(holder, "Tool", {
      file_path: "/repo/a.ts",
      path: "/repo/b.ts",
      notebook_path: "/repo/c.ipynb",
      command: "cat /repo/d.ts",
      pattern: "/repo/e.ts",
    });
    expect(holder.recallHints?.paths).toEqual([
      "/repo/c.ipynb",
      "/repo/b.ts",
      "/repo/a.ts",
    ]);
  });

  it("skips a file value that is not a non-empty string", () => {
    const holder = session();
    noteRecallHints(holder, "Tool", {
      file_path: "",
      path: 17,
      notebook_path: null,
    });
    expect(holder.recallHints?.paths).toEqual([]);
  });

  it("resolves a relative path against the session's directory", () => {
    const holder = session("/repo/src");
    noteRecallHints(holder, "Read", { file_path: "../docs/guide.md" });
    noteRecallHints(holder, "Read", { file_path: "./a.ts" });
    expect(holder.recallHints?.paths).toEqual([
      "/repo/src/a.ts",
      "/repo/docs/guide.md",
    ]);
  });

  it("drops a relative path when the session's directory is not known", () => {
    const holder = session(null);
    noteRecallHints(holder, "Read", { file_path: "src/a.ts" });
    noteRecallHints(holder, "Read", { file_path: "/repo/b.ts" });
    expect(holder.recallHints?.paths).toEqual(["/repo/b.ts"]);
  });

  it("keeps the newest 64 files", () => {
    const holder = session();
    for (let i = 0; i <= RECALL_PATHS_KEPT; i += 1)
      noteRecallHints(holder, "Read", { file_path: `/repo/file-${i}.ts` });
    const paths = holder.recallHints?.paths ?? [];
    expect(paths).toHaveLength(RECALL_PATHS_KEPT);
    expect(paths[0]).toBe(`/repo/file-${RECALL_PATHS_KEPT}.ts`);
    expect(paths.at(-1)).toBe("/repo/file-1.ts");
  });
});

describe("readRepository", () => {
  it("reads once for the same directory or one inside the root", async () => {
    const holder = session();
    const read = vi.fn(async () => REMOTE);
    await readRepository(holder, read);
    await readRepository(holder, read);
    holder.cwd = "/repo/src";
    await readRepository(holder, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("/repo");
  });

  it("shares a read that is still running", async () => {
    const holder = session();
    const read = vi.fn(async () => REMOTE);
    const first = readRepository(holder, read);
    const second = readRepository(holder, read);
    expect(second).toBe(first);
    await expect(first).resolves.toEqual(REMOTE);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads again when the directory leaves the repository", async () => {
    const other: RepositoryRemote = {
      remote_digest: digestBytes("github.com/acme/other"),
      remote_digest_folded: digestBytes("github.com/acme/other"),
      root: "/other",
    };
    const read = vi.fn(async (cwd: string) =>
      cwd.startsWith("/other") ? other : REMOTE,
    );
    const holder = session();
    await readRepository(holder, read);
    holder.cwd = "/other";
    // The read the session holds answers for `/repo` only.
    expect(recallScope(holder).repositoryDigests).toEqual([]);
    await readRepository(holder, read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith("/other");
    // Both of its digests are the same, so the recall sends one.
    expect(recallScope(holder).repositoryDigests).toEqual([
      other.remote_digest,
    ]);
  });

  it("reads the worktree the session writes in, not the checkout it started in", async () => {
    // An agent in a git worktree keeps its `cwd` on the primary checkout and
    // edits files by absolute path, so the directory it last wrote in names
    // the worktree.
    const worktree: RepositoryRemote = {
      remote_digest: digestBytes("github.com/acme/widgets-fix"),
      remote_digest_folded: digestBytes("github.com/acme/widgets-fix.folded"),
      root: "/worktrees/repo/fix",
    };
    const read = vi.fn(async (dir: string) =>
      dir.startsWith("/worktrees/") ? worktree : REMOTE,
    );
    const holder = session();
    holder.workDir = "/worktrees/repo/fix/src";
    noteRecallHints(holder, "Edit", {
      file_path: "/worktrees/repo/fix/src/a.ts",
    });
    await readRepository(holder, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("/worktrees/repo/fix/src");
    expect(recallScope(holder)).toEqual({
      repositoryDigests: [worktree.remote_digest, worktree.remote_digest_folded],
      tools: ["Edit"],
      paths: ["src/a.ts"],
    });
    // A write elsewhere in the worktree keeps the read it holds.
    holder.workDir = "/worktrees/repo/fix/test";
    await readRepository(holder, read);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("answers a failed read as no repository until its wait is over, then reads again (#4458)", async () => {
    let clock = 1_000;
    const now = () => clock;
    const holder = session();
    const read = vi.fn(
      async (): Promise<RepositoryRemote | undefined> => REMOTE,
    );
    read.mockRejectedValueOnce(new Error("git timed out"));
    await expect(readRepository(holder, read, now)).resolves.toBeUndefined();
    expect(holder.recallHints?.repository).toMatchObject({
      settled: true,
      failures: 1,
      retryAt: 1_000 + REPOSITORY_RETRY_FIRST_MS,
    });
    expect(recallScope(holder).repositoryDigests).toEqual([]);
    // A hook inside the wait keeps the failure and runs no git.
    clock += REPOSITORY_RETRY_FIRST_MS - 1;
    await expect(readRepository(holder, read, now)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    // The first hook after the wait asks git again, and the answer replaces
    // the failure.
    clock += 1;
    await expect(readRepository(holder, read, now)).resolves.toEqual(REMOTE);
    expect(read).toHaveBeenCalledTimes(2);
    expect(holder.recallHints?.repository).not.toHaveProperty("failures");
    expect(holder.recallHints?.repository).not.toHaveProperty("retryAt");
    expect(recallScope(holder).repositoryDigests).toEqual(DIGESTS);
    // The repository it found answers from then on.
    clock += REPOSITORY_RETRY_MAX_MS;
    await readRepository(holder, read, now);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("counts a reader that throws at once as a failure", async () => {
    const holder = session();
    await expect(
      readRepository(
        holder,
        () => {
          throw new Error("spawn failed");
        },
        () => 0,
      ),
    ).resolves.toBeUndefined();
    expect(holder.recallHints?.repository).toMatchObject({
      settled: true,
      failures: 1,
      retryAt: REPOSITORY_RETRY_FIRST_MS,
    });
  });

  it("keeps a read that found no origin for the rest of the session", async () => {
    let clock = 0;
    const now = () => clock;
    const holder = session();
    const read = vi.fn(async () => undefined);
    await expect(readRepository(holder, read, now)).resolves.toBeUndefined();
    expect(holder.recallHints?.repository?.settled).toBe(true);
    expect(holder.recallHints?.repository).not.toHaveProperty("failures");
    expect(holder.recallHints?.repository).not.toHaveProperty("retryAt");
    clock += 24 * 60 * 60_000;
    await readRepository(holder, read, now);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("doubles the wait with each failure in a row, up to its cap", async () => {
    let clock = 0;
    const now = () => clock;
    const holder = session();
    const read = vi.fn(async (): Promise<RepositoryRemote | undefined> => {
      throw new Error("dubious ownership");
    });
    const waits: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      await readRepository(holder, read, now);
      const retryAt = holder.recallHints?.repository?.retryAt ?? clock;
      waits.push(retryAt - clock);
      clock = retryAt;
    }
    expect(read).toHaveBeenCalledTimes(7);
    expect(waits).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000,
    ]);
    expect(holder.recallHints?.repository?.failures).toBe(7);
  });

  it("starts the count again in a directory that has not failed", async () => {
    let clock = 0;
    const now = () => clock;
    const holder = session();
    const read = vi.fn(async (): Promise<RepositoryRemote | undefined> => {
      throw new Error("git timed out");
    });
    await readRepository(holder, read, now);
    clock = holder.recallHints?.repository?.retryAt ?? clock;
    await readRepository(holder, read, now);
    expect(holder.recallHints?.repository?.failures).toBe(2);
    // A write elsewhere moves the session, and a failed read has no root to
    // cover the new directory, so it is read now.
    holder.workDir = "/scratch";
    await readRepository(holder, read, now);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenLastCalledWith("/scratch");
    expect(holder.recallHints?.repository).toMatchObject({
      cwd: "/scratch",
      failures: 1,
      retryAt: clock + REPOSITORY_RETRY_FIRST_MS,
    });
  });

  it("reads nothing for a session with no directory", () => {
    const read = vi.fn(async () => REMOTE);
    expect(readRepository(session(null), read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("recallScope", () => {
  it("sends nothing before a hook noted anything", () => {
    expect(recallScope(session())).toEqual({
      repositoryDigests: [],
      tools: [],
      paths: [],
    });
  });

  it("names files from the root and drops any it cannot name", async () => {
    const holder = session();
    const files = [
      "/repo/src/a.ts",
      "/elsewhere/b.ts",
      "/repo",
      `/repo/${"x".repeat(513)}`,
      `/repo/${"y".repeat(512)}`,
      "/repository/c.ts",
    ];
    for (const file_path of files)
      noteRecallHints(holder, "Read", { file_path });
    await readRepository(holder, async () => REMOTE);
    expect(recallScope(holder)).toEqual({
      repositoryDigests: DIGESTS,
      tools: ["Read"],
      paths: ["y".repeat(512), "src/a.ts"],
    });
  });

  it("names no files while the read is still running", () => {
    const holder = session();
    noteRecallHints(holder, "Read", { file_path: "/repo/src/a.ts" });
    void readRepository(
      holder,
      () => new Promise<RepositoryRemote | undefined>(() => undefined),
    );
    expect(recallScope(holder)).toEqual({
      repositoryDigests: [],
      tools: ["Read"],
      paths: [],
    });
  });

  it("names no files when the read found no root", async () => {
    const holder = session();
    noteRecallHints(holder, "Read", { file_path: "/repo/src/a.ts" });
    await readRepository(holder, async () => ({
      remote_digest: REMOTE.remote_digest,
      remote_digest_folded: REMOTE.remote_digest_folded,
    }));
    expect(recallScope(holder)).toEqual({
      repositoryDigests: DIGESTS,
      tools: ["Read"],
      paths: [],
    });
  });

  it("hands back copies, so a caller cannot change the session's lists", () => {
    const holder = session();
    noteRecallHints(holder, "Read", undefined);
    recallScope(holder).tools.push("Write");
    expect(recallScope(holder).tools).toEqual(["Read"]);
  });
});

describe("forgetRecallHints", () => {
  it("clears the hints, and a later read answer restores none", async () => {
    const holder = session();
    let finish: (remote: RepositoryRemote) => void = () => undefined;
    const pending = readRepository(
      holder,
      () =>
        new Promise<RepositoryRemote | undefined>((resolve) => {
          finish = resolve;
        }),
    );
    noteRecallHints(holder, "Read", { file_path: "/repo/a.ts" });
    forgetRecallHints(holder);
    expect(holder.recallHints).toBeUndefined();
    // The reader runs after `readRepository` returns, so `finish` is set
    // only once the pending callbacks have run.
    await settle();
    finish(REMOTE);
    await pending;
    expect(holder.recallHints).toBeUndefined();
    expect(recallScope(holder)).toEqual({
      repositoryDigests: [],
      tools: [],
      paths: [],
    });
  });
});
