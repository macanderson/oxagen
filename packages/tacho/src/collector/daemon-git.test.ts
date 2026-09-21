/**
 * The daemon's git seam: what it reads, when it reads it, and where the
 * reading happens.
 *
 * Three things are asserted here that the rest of the daemon suite does not
 * touch. A hook never spawns git, because a hook holds the queue every
 * wrapped agent on the host waits on. A worktree is reconciled at the end of
 * a turn and nowhere else. And a git read that succeeds replaces the whole
 * git context, so a checkout that went detached stops reporting the branch
 * it left.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSensitiveFileAtomic } from "../host/fs";
import { readHostFile, writeHostFile } from "../host/host-file";
import { mergeTachoSettings } from "../host/settings-writer";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
} from "../host/test-support";
import { unsignedBundle } from "../host/test-support";
import type { Exec, ExecAsync } from "../host/service";
import type { TachoEvent } from "../envelope";
import { type DaemonHandle, startDaemon } from "./daemon";

const SESSION = "11111111-2222-3333-4444-555555555555";
const CWD = "/repo";

/** A git that answers canned stdout, recording every invocation. */
function fakeGit(
  answers: () => Record<string, string>,
  calls: string[][],
): Exec {
  return (command, args) => {
    calls.push([command, ...args]);
    if (command !== "git") return { status: 127, stdout: "", stderr: "" };
    for (const [key, value] of Object.entries(answers())) {
      if (args.join(" ").includes(key))
        return { status: 0, stdout: value, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "no answer" };
  };
}

const REPO_ANSWERS: Record<string, string> = {
  "rev-parse HEAD": `${"a".repeat(40)}\n`,
  "rev-parse --abbrev-ref HEAD": "main\n",
  "status --porcelain=v1 -z": " M src/a.ts\x00?? src/new.ts\x00",
  "status --porcelain": " M src/a.ts\n",
  "remote get-url origin": "git@github.com:acme/repo.git\n",
  "diff --numstat HEAD": "4\t1\tsrc/a.ts\x00",
  "rev-parse --show-toplevel": `${CWD}\n`,
  // The untracked probe: `--no-index` exits 1 to say the inputs differ.
  "--no-index": "27\t0\t\x00/dev/null\x00/repo/src/new.ts\x00",
};

function hook(name: string, extra: Record<string, unknown> = {}) {
  return {
    payload: {
      session_id: SESSION,
      hook_event_name: name,
      cwd: CWD,
      ...extra,
    },
    env: {},
  };
}

describe("the daemon's git seam", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(
    exec: Exec,
    now: () => number,
    execAsync?: ExecAsync,
    // Called on every control-plane request, so a test can record where the
    // poll falls relative to the git spawns.
    onFetch?: (url: string) => void,
    // Run the real interval driver, for the one case that is about the driver's
    // `ticking` guard rather than about the order inside a single tick.
    driver?: { shipMs: number },
  ) {
    const paths = scratchPaths();
    const signer = bundleSigner();
    const bundle = signer.sign(
      unsignedBundle({
        permissions: { allow: ["Read", "Bash(echo *)"], deny: [], ask: [] },
      }),
    );
    const host = readHostFile(paths.hostFile) ?? testHostFile(signer, bundle);
    writeHostFile(paths.hostFile, host);
    writeSensitiveFileAtomic(
      paths.claudeSettings,
      JSON.stringify(
        mergeTachoSettings(
          {},
          {
            enrollmentId: TEST_ENROLLMENT,
            hookCommand: "x",
            port: 1,
            localToken: host.local_token,
          },
        ).settings,
      ),
    );
    const handle = await startDaemon({
      paths,
      fetch: async (url) => {
        onFetch?.(url);
        throw new Error("ECONNREFUSED");
      },
      exec,
      ...(execAsync !== undefined ? { execAsync } : {}),
      now,
      log: () => undefined,
      listen: driver !== undefined,
      ...(driver !== undefined ? { port: 0 } : {}),
      transcriptRoots: [`${paths.root}/no-transcripts`],
      timers: {
        detectorMs: 0,
        sweepMs: 0,
        checkpointMs: 0,
        commandsPollMs: 0,
        ...(driver ?? {}),
        ...(driver !== undefined ? { bundleRefreshMs: 0 } : {}),
      },
    });
    handles.push(handle);
    return handle;
  }

  /** Every frame the session's chain holds, in order. */
  function frames(handle: DaemonHandle): TachoEvent[] {
    const record = handle.registry.get(SESSION);
    return [...(record?.recorder.sealedEvents ?? [])];
  }

  function reconciliations(handle: DaemonHandle): TachoEvent[] {
    return frames(handle).filter(
      (event) => event.kind === "oxagen:worktree_reconciled",
    );
  }

  it("continues command polling, reconciliation, and compaction after a body read fails", async () => {
    const calls: string[][] = [];
    const requests: string[] = [];
    const handle = await boot(
      fakeGit(() => REPO_ANSWERS, calls),
      () => 3_600_000,
      undefined,
      (url) => requests.push(url),
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("Stop"));
    const bodies = vi
      .spyOn(handle.wal, "bodiesFor")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("body stream failed"), { code: "EIO" });
      });
    const compact = vi.spyOn(handle.wal, "compact");
    requests.length = 0;
    await expect(handle.tick()).resolves.toBeUndefined();
    expect(handle.shipper.lastError).toBe("body stream failed");
    expect(handle.shipper.ready()).toBe(false);
    expect(handle.wal.unshipped(100).length).toBeGreaterThan(0);
    expect(requests.some((url) => url.endsWith("/commands"))).toBe(true);
    expect(reconciliations(handle)).toHaveLength(1);
    expect(compact).toHaveBeenCalledOnce();
    bodies.mockRestore();
    compact.mockRestore();
  });

  it("spawns no git while a hook is being answered", async () => {
    const calls: string[][] = [];
    const handle = await boot(
      fakeGit(() => REPO_ANSWERS, calls),
      () => 1_000,
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: "go" }));
    await handle.api.handleHook(hook("Stop"));
    // The hooks are answered; the reads are still only requested.
    expect(calls.filter((call) => call[0] === "git")).toEqual([]);
  });

  it("answers a hook while a worktree read is still in flight", async () => {
    // The reason the reads are asynchronous. A tick may read up to four
    // worktrees, several git commands apiece with a ten second ceiling on
    // each, and a synchronous probe would hold the only event loop for all
    // of it. Every hook arriving in that window would wait out its budget
    // and fall back to deciding locally, which is the mandate going
    // unenforced.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const slow: ExecAsync = async (command, args) => {
      started = true;
      await held;
      for (const [key, value] of Object.entries(REPO_ANSWERS)) {
        if (args.join(" ").includes(key))
          return { status: 0, stdout: value, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "no answer" };
    };
    const handle = await boot(
      fakeGit(() => REPO_ANSWERS, []),
      () => 1_000,
      slow,
    );
    await handle.api.handleHook(hook("SessionStart"));
    const ticking = handle.tick();
    // Wait for the probe to actually start rather than assuming one turn of
    // the event loop is enough. The tick does a variable amount of work
    // before it reaches the first git command, so a single `setTimeout(0)`
    // sometimes returned first and the assertion below failed for timing
    // rather than for behaviour. Measured at roughly one run in four.
    const deadline = Date.now() + 2_000;
    while (!started && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(started).toBe(true);
    const answered = await handle.api.handleHook(
      hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: "a" } }),
    );
    expect(answered).toBeDefined();
    release();
    await ticking;
  });

  it("reconciles the worktree at the end of a turn", async () => {
    const calls: string[][] = [];
    const handle = await boot(
      fakeGit(() => REPO_ANSWERS, calls),
      () => 1_000,
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("Stop"));
    await handle.tick();
    const sealed = reconciliations(handle);
    expect(sealed).toHaveLength(1);
    const body = sealed[0]?.body as Record<string, unknown>;
    expect(body["observed_changes_total"]).toBe(2);
    expect(body["observed_changes_truncated"]).toBe(false);
    expect(body["observed_changes"]).toEqual([
      {
        path: "/repo/src/a.ts",
        repo_relative_path: "src/a.ts",
        status: "modified",
        lines_added: 4,
        lines_removed: 1,
      },
      {
        // An untracked file appears in no diff against `HEAD`, so its count
        // comes from a separate `--no-index` probe rather than from a zero
        // the record would then keep.
        path: "/repo/src/new.ts",
        repo_relative_path: "src/new.ts",
        status: "added",
        lines_added: 27,
        lines_removed: 0,
      },
    ]);
  });

  it("polls control state before it spawns any git", async () => {
    // The git reads are the slow lane: one session can put 64 untracked-file
    // probes through a four-worker pool at ten seconds each, and the tick
    // guard drops anything that overlaps. With the reconciliation ahead of
    // the control poll, an operator's suspend, revoke or cancel waited behind
    // it while hooks kept answering from the allow state that operator had
    // just withdrawn.
    const timeline: string[] = [];
    const handle = await boot(
      (command, args) => {
        if (command === "git") timeline.push("git");
        for (const [key, value] of Object.entries(REPO_ANSWERS)) {
          if (args.join(" ").includes(key))
            return { status: 0, stdout: value, stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "no answer" };
      },
      () => 1_000,
      undefined,
      () => timeline.push("control"),
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("Stop"));
    timeline.length = 0;
    await handle.tick();
    // Both happened in this tick, and control came first.
    expect(timeline).toContain("control");
    expect(timeline).toContain("git");
    expect(timeline.indexOf("control")).toBeLessThan(timeline.indexOf("git"));
  });

  it("keeps polling control state while a worktree read is stuck", async () => {
    // Ordering inside one tick is the other test above. This is the half
    // ordering cannot fix.
    //
    // A reconciliation's ceilings multiply: `readGitFacts` is `rev-parse HEAD`
    // then three reads at once (2 x 10 s), and `readWorkingTreeChanges` is
    // `status`, then numstat-and-root at once with a no-HEAD fallback, then 64
    // untracked probes through a pool of 4, which is 16 waves — 10 + 20 + 160 s,
    // so 210 s for one session and 840 s for the four a tick drains. Awaited
    // anywhere inside the tick, that holds the interval driver's `ticking`
    // guard for the whole fourteen minutes and every poll in between is
    // dropped, whichever end of the tick the drain sits at. The allow state the
    // hooks read would stay fourteen minutes behind the operator's withdrawal
    // of it, and the record would name the withdrawn state as the live one.
    //
    // So the drain runs in a lane of its own, and this asserts the consequence:
    // the driver keeps polling while a git read is in flight and will not
    // answer.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let probeStarted = false;
    const stuck: ExecAsync = async () => {
      probeStarted = true;
      await held;
      return { status: 1, stdout: "", stderr: "released" };
    };
    let polls = 0;
    const handle = await boot(
      fakeGit(() => REPO_ANSWERS, []),
      () => 1_000,
      stuck,
      () => {
        polls += 1;
      },
      { shipMs: 10 },
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("Stop"));
    const started = Date.now() + 2_000;
    while (!probeStarted && Date.now() < started)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(probeStarted).toBe(true);

    // Several polls, not one. Awaited in the tick, the guard is held by the
    // stuck read and the count stops at the poll that preceded it.
    polls = 0;
    const deadline = Date.now() + 1_500;
    while (polls < 3 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(polls).toBeGreaterThanOrEqual(3);

    release();
  });

  it("does not reconcile on a tool call or a prompt", async () => {
    const calls: string[][] = [];
    const handle = await boot(
      fakeGit(() => REPO_ANSWERS, calls),
      () => 1_000,
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.tick();
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: "go" }));
    await handle.tick();
    await handle.api.handleHook(
      hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: "a" } }),
    );
    await handle.tick();
    await handle.api.handleHook(
      hook("PostToolUse", {
        tool_name: "Read",
        tool_input: { file_path: "a" },
      }),
    );
    await handle.tick();
    expect(reconciliations(handle)).toHaveLength(0);
    // The context read still happened, so this is not a dead seam.
    expect(
      calls.some((call) => call.join(" ").includes("rev-parse HEAD")),
    ).toBe(true);
    expect(
      calls.some((call) => call.join(" ").includes("--porcelain=v1 -z")),
    ).toBe(false);
  });

  it("samples at most one reconciliation per fifteen seconds", async () => {
    let clock = 1_000;
    const handle = await boot(
      fakeGit(() => REPO_ANSWERS, []),
      () => clock,
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("Stop"));
    await handle.tick();
    clock += 5_000;
    await handle.api.handleHook(hook("Stop"));
    await handle.tick();
    expect(reconciliations(handle)).toHaveLength(1);
    clock += 15_000;
    await handle.api.handleHook(hook("Stop"));
    await handle.tick();
    expect(reconciliations(handle)).toHaveLength(2);
  });

  it("seals nothing for a directory that is not a repository", async () => {
    const calls: string[][] = [];
    const handle = await boot(
      fakeGit(() => ({}), calls),
      () => 1_000,
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("Stop"));
    await handle.tick();
    expect(reconciliations(handle)).toHaveLength(0);
    // It does reach for the worktree, and that read is what decides. A
    // missing HEAD covers both a directory that is no repository and a
    // repository whose first commit has not been made, and only the status
    // read tells them apart. Here it answers nothing, so nothing is sealed.
    expect(
      calls.some((call) => call.join(" ").includes("--porcelain=v1 -z")),
    ).toBe(true);
  });

  it("reconciles a repository whose first commit has not been made", async () => {
    // `rev-parse HEAD` fails on an unborn repository, so the facts read
    // declines it. The worktree is real and full of creates, and the
    // worktree reader has its own fallback for an absent HEAD, so skipping
    // the reconciliation lost every file in a fresh repository until its
    // first commit.
    const handle = await boot(
      fakeGit(
        () => ({
          "status --porcelain=v1 -z": "?? src/new.ts\x00",
          "rev-parse --show-toplevel": "/repo\n",
        }),
        [],
      ),
      () => 1_000,
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("Stop"));
    await handle.tick();

    const sealed = reconciliations(handle);
    expect(sealed).toHaveLength(1);
    expect(
      (sealed[0]?.body as { observed_changes: { path: string }[] })
        .observed_changes[0]?.path,
    ).toContain("src/new.ts");
  });

  it("clears a branch git no longer reports", async () => {
    let answers = { ...REPO_ANSWERS };
    let clock = 1_000;
    const handle = await boot(
      fakeGit(() => answers, []),
      () => clock,
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: "one" }));
    await handle.tick();
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: "two" }));
    expect(frames(handle).at(-1)?.context?.git_branch).toBe("main");

    // A detached checkout: `rev-parse --abbrev-ref HEAD` answers `HEAD`, which
    // names no branch, and the reader omits the member.
    answers = { ...answers, "rev-parse --abbrev-ref HEAD": "HEAD\n" };
    clock += 60_000;
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: "three" }));
    await handle.tick();
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: "four" }));
    const latest = frames(handle).at(-1)?.context;
    expect(latest?.git_branch).toBeUndefined();
    expect(latest?.git_head_sha).toBe("a".repeat(40));
  });

  it("leaves the branch alone when the git read fails outright", async () => {
    let answers = { ...REPO_ANSWERS };
    let clock = 1_000;
    const handle = await boot(
      fakeGit(() => answers, []),
      () => clock,
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: "one" }));
    await handle.tick();
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: "two" }));
    expect(frames(handle).at(-1)?.context?.git_branch).toBe("main");

    // Git gone, or the directory unreadable. That is not a report of a
    // detached head, it is no report at all, so nothing is cleared.
    answers = {};
    clock += 60_000;
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: "three" }));
    await handle.tick();
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: "four" }));
    expect(frames(handle).at(-1)?.context?.git_branch).toBe("main");
  });
});
