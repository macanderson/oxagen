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

  // A forced sync that restored only `missing` left a local-only rule on
  // disk and reported success, so the agent kept reading a record production
  // never held.
  it("reconciles local-only and dirty files to production under --force", async () => {
    const run = vi.fn<GitRunner>(async (args) => {
      if (args[0] === "rev-parse") return REMOTE_SHA;
      // Production holds the edited rule, not the branch's own one.
      if (args[0] === "ls-tree") {
        return args.includes(".oxagen/rules/ctx.edited.toml")
          ? `100644 blob abc\t.oxagen/rules/ctx.edited.toml\0`
          : "";
      }
      return "";
    });
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict({
        status: "diverged",
        local: [{ status: "added", path: ".oxagen/rules/ctx.mine.toml" }],
        dirty: [".oxagen/rules/ctx.edited.toml", ".oxagen/rules/ctx.mine.toml"],
      }),
      run,
      force: true,
    });
    expect(result.applied).toBe(true);
    expect(result.updated).toEqual([
      ".oxagen/rules/ctx.a.toml",
      ".oxagen/rules/ctx.edited.toml",
    ]);
    expect(result.removed).toEqual([".oxagen/rules/ctx.mine.toml"]);
    const calls = run.mock.calls.map((c) => c[0]);
    expect(
      calls.some(
        (a) => a[0] === "rm" && a.includes(".oxagen/rules/ctx.mine.toml"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (a) => a[0] === "clean" && a.includes(".oxagen/rules/ctx.mine.toml"),
      ),
    ).toBe(true);
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
        "--ignore-skip-worktree-bits",
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

// A slow `restore`, `rm`, or `clean` defaulting to the standalone 30-second
// `timeoutMs` could alone outlive the installed hook's own 20-second
// timeout, so the harness kills the gate before the blocking decision is
// rendered and the prompt proceeds despite `blockStaleRuns`. `deadlineMs`
// bounds every call this sync makes to whatever is left of a caller's own
// shared budget instead.
describe("syncSteering deadline clamping", () => {
  it("clamps every git call's timeout to what is left of the deadline", async () => {
    const seenTimeouts: number[] = [];
    const run: GitRunner = async (args, opts) => {
      seenTimeouts.push(opts.timeoutMs);
      return args[0] === "rev-parse" ? REMOTE_SHA : "";
    };
    const now = 1_000_000;
    await syncSteering({
      cwd: "/repo",
      verdict: verdict({
        missing: [{ status: "added", path: ".oxagen/rules/a.toml" }],
      }),
      run,
      timeoutMs: 30_000,
      deadlineMs: now + 2_000,
      now: () => now,
    });
    // Every call was clamped well under the standalone 30 s default.
    expect(seenTimeouts.every((t) => t <= 2_000)).toBe(true);
  });

  it("floors a call at MIN_SYNC_SLICE_MS rather than handing it a zero timeout", async () => {
    const seenTimeouts: number[] = [];
    const run: GitRunner = async (args, opts) => {
      seenTimeouts.push(opts.timeoutMs);
      return args[0] === "rev-parse" ? REMOTE_SHA : "";
    };
    const now = 5_000_000;
    // The deadline has already passed by the time the sync starts.
    await syncSteering({
      cwd: "/repo",
      verdict: verdict({
        missing: [{ status: "added", path: ".oxagen/rules/a.toml" }],
      }),
      run,
      deadlineMs: now - 5_000,
      now: () => now,
    });
    expect(seenTimeouts.every((t) => t === 1_000)).toBe(true);
  });

  it("leaves the plain timeoutMs alone when no deadline is given", async () => {
    const seenTimeouts: number[] = [];
    const run: GitRunner = async (args, opts) => {
      seenTimeouts.push(opts.timeoutMs);
      return args[0] === "rev-parse" ? REMOTE_SHA : "";
    };
    await syncSteering({
      cwd: "/repo",
      verdict: verdict({
        missing: [{ status: "added", path: ".oxagen/rules/a.toml" }],
      }),
      run,
      timeoutMs: 12_345,
    });
    expect(seenTimeouts.every((t) => t === 12_345)).toBe(true);
  });
});

// Clamping bounds each call; it does not bound the run. With the shared
// deadline already gone every batch still got the floor, and a large rules
// directory is many batches, so the sync could still outlive the hook the
// harness kills. So it refuses instead, and a refusal is not a silent pass:
// `applied` false leaves the gate's verdict stale and a blocking policy
// blocks.
describe("syncSteering when the shared deadline is spent", () => {
  it("refuses before touching anything when too little time is left", async () => {
    const run = vi.fn(okRunner);
    const clock = 1_000_000;
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict(),
      run,
      deadlineMs: clock + 200,
      now: () => clock,
    });
    expect(result.refusal).toBe("out_of_time");
    expect(result.applied).toBe(false);
    // Nothing ran, so the working copy is exactly as the sync found it.
    expect(run).not.toHaveBeenCalled();
    expect(result.message).toContain("oxagen steering sync");
  });

  it("stops between batches and reports the part that landed", async () => {
    let clock = 1_000_000;
    const deadlineMs = clock + 5_000;
    const missing = Array.from({ length: 250 }, (_, i) => ({
      status: "added" as const,
      path: `.oxagen/rules/ctx.${i}.toml`,
    }));
    const run: GitRunner = async (args) => {
      if (args[0] === "rev-parse") return REMOTE_SHA;
      // The first restore batch eats the rest of the deadline.
      clock += 4_900;
      return "";
    };
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict({ missing }),
      run,
      deadlineMs,
      now: () => clock,
    });
    expect(result.applied).toBe(false);
    expect(result.refusal).toBe("out_of_time");
    expect(result.message).toContain("200 of 250 file(s)");
    expect(result.message).toContain("git restore --staged --worktree .oxagen");
  });

  it("does not refuse a person running it with no deadline at all", async () => {
    const result = await syncSteering({
      cwd: "/repo",
      verdict: verdict(),
      run: okRunner,
    });
    expect(result.applied).toBe(true);
    expect(result.refusal).toBeNull();
  });
});
