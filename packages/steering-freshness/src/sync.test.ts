import { describe, expect, it, vi } from "vitest";
import { syncSteering } from "./sync";
import type { FreshnessVerdict } from "./check";
import type { GitRunner } from "./git";

const REMOTE_SHA = "4444444444444444444444444444444444444444";

function verdict(over: Partial<FreshnessVerdict> = {}): FreshnessVerdict {
  return {
    status: "behind",
    remote: "origin",
    branch: "main",
    missing: [{ status: "added", path: ".oxagen/rules/ctx.a.toml" }],
    local: [],
    dirty: [],
    behindByCommits: 1,
    fingerprint: { local: "a", remote: "b" },
    fetch: { attempted: true, ok: true, reason: null },
    notes: [],
    platform: null,
    ...over,
  };
}

const okRunner: GitRunner = async (args) =>
  args[0] === "rev-parse" ? REMOTE_SHA : "";

describe("syncSteering refusals", () => {
  it("refuses when freshness is unknown, and says why", async () => {
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict({ status: "unknown", notes: ["offline"] }),
      run: okRunner,
    });
    expect(result.applied).toBe(false);
    expect(result.refusal).toBe("unknown_state");
    expect(result.message).toContain("offline");
  });

  it.each(["current", "ahead"] as const)("refuses when %s", async (status) => {
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict({ status, missing: [] }),
      run: okRunner,
    });
    expect(result.refusal).toBe("not_behind");
  });

  it("refuses a diverged checkout rather than overwriting authoring", async () => {
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict({
        status: "diverged",
        local: [{ status: "added", path: ".oxagen/rules/ctx.mine.toml" }],
      }),
      run: okRunner,
    });
    expect(result.refusal).toBe("diverged");
    expect(result.message).toContain("ctx.mine.toml");
    expect(result.message).toContain("--force");
  });

  // Uncommitted work anywhere under `.oxagen/` stops the sync, even in a file
  // this sync would not have written.
  it("refuses a dirty .oxagen", async () => {
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict({ dirty: [".oxagen/workspace.json"] }),
      run: okRunner,
    });
    expect(result.refusal).toBe("dirty");
    expect(result.message).toContain(".oxagen/workspace.json");
  });

  it("refuses when the remote ref has gone missing", async () => {
    const run: GitRunner = async () => {
      throw new Error("no such ref");
    };
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict(),
      run,
    });
    expect(result.refusal).toBe("remote_ref_missing");
  });

  // The platform fallback's own case: Oxagen knows a promotion was published
  // at a commit this checkout cannot reach, so the verdict is `behind` and
  // `missing` is empty, because the remote-tracking ref on disk has nothing
  // for git to diff against. Falling through wrote no files and returned
  // `applied: true` with "0 file(s) synced", so an enforced gate re-checked,
  // refused again, and recommended the same command — a loop whose every step
  // reported success.
  it("refuses when it is behind but has nothing on disk to copy", async () => {
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict({ missing: [] }),
      run: okRunner,
    });
    expect(result.refusal).toBe("remote_ref_stale");
    expect(result.applied).toBe(false);
    expect(result.message).toContain("git fetch origin");
  });

  it("refuses the same way on a dry run, rather than offering 0 files", async () => {
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict({ missing: [] }),
      run: okRunner,
      dryRun: true,
    });
    expect(result.refusal).toBe("remote_ref_stale");
  });

  it("still refuses unknown even with --force", async () => {
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict({ status: "unknown" }),
      run: okRunner,
      force: true,
    });
    expect(result.refusal).toBe("unknown_state");
  });

  it("proceeds past dirty and diverged with --force", async () => {
    const run = vi.fn(okRunner);
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict({
        status: "diverged",
        local: [{ status: "added", path: ".oxagen/rules/ctx.mine.toml" }],
        dirty: [".oxagen/rules/ctx.mine.toml"],
      }),
      run,
      force: true,
    });
    expect(result.applied).toBe(true);
  });
});

describe("syncSteering applying", () => {
  it("restores added and modified paths into the index and the working copy", async () => {
    const run = vi.fn(okRunner);
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict({
        missing: [
          { status: "added", path: ".oxagen/rules/a.toml" },
          { status: "modified", path: ".oxagen/rules/b.toml" },
        ],
      }),
      run,
    });
    expect(result.applied).toBe(true);
    expect(result.updated).toEqual([
      ".oxagen/rules/a.toml",
      ".oxagen/rules/b.toml",
    ]);
    expect(run).toHaveBeenCalledWith(
      [
        "restore",
        `--source=${REMOTE_SHA}`,
        "--staged",
        "--worktree",
        "--",
        ".oxagen/rules/a.toml",
        ".oxagen/rules/b.toml",
      ],
      expect.anything(),
    );
  });

  it("removes paths the production branch deleted", async () => {
    const run = vi.fn(okRunner);
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict({
        missing: [{ status: "removed", path: ".oxagen/rules/gone.toml" }],
      }),
      run,
    });
    expect(result.removed).toEqual([".oxagen/rules/gone.toml"]);
    expect(run).toHaveBeenCalledWith(
      [
        "rm",
        "--quiet",
        "--force",
        "--ignore-unmatch",
        "--",
        ".oxagen/rules/gone.toml",
      ],
      expect.anything(),
    );
  });

  // Committing from inside a prompt submission is the surprise that gets
  // automation revoked, so the default leaves the change staged.
  it("stages without committing by default", async () => {
    const run = vi.fn(okRunner);
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict(),
      run,
    });
    expect(result.committed).toBe(false);
    expect(run.mock.calls.some(([args]) => args[0] === "commit")).toBe(false);
    expect(result.message).toContain("staged");
  });

  it("commits when asked", async () => {
    const run = vi.fn(okRunner);
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict(),
      run,
      commit: true,
    });
    expect(result.committed).toBe(true);
    expect(run.mock.calls.some(([args]) => args[0] === "commit")).toBe(true);
  });

  it("writes nothing on a dry run", async () => {
    const run = vi.fn(okRunner);
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict(),
      run,
      dryRun: true,
    });
    expect(result.applied).toBe(false);
    expect(result.refusal).toBeNull();
    expect(result.updated).toHaveLength(1);
    expect(run.mock.calls.some(([args]) => args[0] === "restore")).toBe(false);
  });

  it("batches a very large rules directory rather than overrunning argv", async () => {
    const run = vi.fn(okRunner);
    const missing = Array.from({ length: 450 }, (_, i) => ({
      status: "added" as const,
      path: `.oxagen/rules/ctx.${i}.toml`,
    }));
    await syncSteering({ cwd: "/repo", verdict: verdict({ missing }), run });
    const restores = run.mock.calls.filter(([args]) => args[0] === "restore");
    expect(restores).toHaveLength(3);
  });
});
