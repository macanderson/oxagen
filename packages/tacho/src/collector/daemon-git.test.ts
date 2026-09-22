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
/** A second live session, for the cases about one tick's batch of sessions. */
const SIBLING = "99999999-8888-7777-6666-555555555555";
const CWD = "/repo";

/** The sequence numbers a chain's frames carry, in the order they were read. */
function seqs(events: readonly TachoEvent[]): number[] {
  return events.map((event) => event.seq);
}

/** The sequence numbers a gap-free chain of that length would carry. */
function positions(events: readonly TachoEvent[]): number[] {
  return events.map((_, index) => index);
}

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

// `rev-parse HEAD` below fixes the session's baseline the moment its git
// facts are first read, and every reconciliation after that diffs against
// this sha rather than against a `HEAD` the session's own commits keep
// moving (see `readWorkingTreeChanges`'s `ref = baseline ?? "HEAD"`).
const BASELINE_SHA = "a".repeat(40);

const REPO_ANSWERS: Record<string, string> = {
  "rev-parse HEAD": `${BASELINE_SHA}\n`,
  "rev-parse --abbrev-ref HEAD": "main\n",
  "status --porcelain=v1 -z": " M src/a.ts\x00?? src/new.ts\x00",
  "status --porcelain": " M src/a.ts\n",
  "remote get-url origin": "git@github.com:acme/repo.git\n",
  // The tracked half of a reconciliation: `diff --name-status -z` against
  // the fixed baseline.
  "diff --name-status -z": "M\x00src/a.ts\x00",
  // The line counts for that same diff, against the same baseline.
  [`diff --numstat ${BASELINE_SHA}`]: "4\t1\tsrc/a.ts\x00",
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
    existingPaths?: ReturnType<typeof scratchPaths>,
  ) {
    const paths = existingPaths ?? scratchPaths();
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

  it.each([true, false])(
    "finishes a pending final read before sealing, including unavailable Git: %s",
    async (available) => {
      const calls: string[][] = [];
      const handle = await boot(
        fakeGit(() => (available ? REPO_ANSWERS : {}), calls),
        () => 1_000,
      );
      await handle.api.handleHook(hook("SessionStart"));
      await handle.api.handleHook(hook("Stop"));
      await handle.api.handleHook(hook("SessionEnd"));
      expect(handle.registry.get(SESSION)?.sealed).toBe(false);
      await handle.tick();
      const events = frames(handle);
      expect(handle.registry.get(SESSION)?.sealed).toBe(true);
      expect(reconciliations(handle)).toHaveLength(available ? 1 : 0);
      const end = events.findIndex((event) => event.kind === "agent_stop");
      expect(end).toBeGreaterThan(-1);
      if (available)
        expect(
          events.findIndex(
            (event) => event.kind === "oxagen:worktree_reconciled",
          ),
        ).toBeLessThan(end);
    },
  );

  it("recovers a deferred session end after the daemon restarts", async () => {
    const paths = scratchPaths();
    const exec = fakeGit(() => REPO_ANSWERS, []);
    const first = await boot(
      exec,
      () => 1_000,
      undefined,
      undefined,
      undefined,
      paths,
    );
    await first.api.handleHook(hook("SessionStart"));
    await first.api.handleHook(hook("Stop"));
    await first.api.handleHook(hook("SessionEnd"));
    await first.stop();
    const next = await boot(
      exec,
      () => 2_000,
      undefined,
      undefined,
      undefined,
      paths,
    );
    await next.tick();
    expect(next.registry.get(SESSION)?.sealed).toBe(true);
    expect(reconciliations(next)).toHaveLength(1);
    const events = [
      ...next.wal.read(next.registry.get(SESSION)!.recorder.sessionUuid),
    ];
    expect(
      events.findIndex((event) => event.kind === "oxagen:worktree_reconciled"),
    ).toBeLessThan(events.findIndex((event) => event.kind === "agent_stop"));
  });

  it("does not let a dead-process sweep seal ahead of the final read", async () => {
    let release = (): void => undefined;
    let started = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const exec = fakeGit(() => REPO_ANSWERS, []);
    const handle = await boot(
      exec,
      () => 1_000,
      async (command, args) => {
        started();
        await held;
        return exec(command, args);
      },
    );
    await handle.api.handleHook({
      ...hook("SessionStart"),
      env: { CLAUDE_PID: "2147483647" },
    });
    await handle.api.handleHook(hook("Stop"));
    await handle.api.handleHook(hook("SessionEnd"));
    const ticking = handle.tick();
    await entered;
    try {
      expect(handle.registry.get(SESSION)?.sealed).toBe(false);
    } finally {
      release();
    }
    await ticking;
    expect(reconciliations(handle)).toHaveLength(1);
    expect(handle.registry.get(SESSION)?.sealed).toBe(true);
  });

  it("requeues a throttled Stop until its observation is eligible", async () => {
    let time = 1_000;
    const handle = await boot(
      fakeGit(() => REPO_ANSWERS, []),
      () => time,
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("Stop"));
    await handle.tick();
    await handle.api.handleHook(hook("Stop"));
    await handle.tick();
    expect(reconciliations(handle)).toHaveLength(1);
    time += 15_000;
    await handle.tick();
    expect(reconciliations(handle)).toHaveLength(2);
  });

  it("keeps final reads separate when two harnesses reuse a session id", async () => {
    const handle = await boot(
      fakeGit(() => REPO_ANSWERS, []),
      () => 1_000,
    );
    for (const harness of ["claude-code", "codex"] as const) {
      await handle.api.handleHook({ ...hook("SessionStart"), harness });
      await handle.api.handleHook({ ...hook("Stop"), harness });
    }
    await handle.api.handleHook({ ...hook("SessionEnd"), harness: "codex" });
    await handle.tick();
    const sessions = handle.registry
      .list()
      .filter((session) => session.harnessSessionId === SESSION);
    expect(sessions).toHaveLength(2);
    expect(
      new Set(sessions.map((session) => session.recorder.sessionUuid)).size,
    ).toBe(2);
    expect(
      sessions.find((session) => session.harness === "codex")?.sealed,
    ).toBe(true);
    expect(
      sessions.find((session) => session.harness !== "codex")?.sealed,
    ).toBe(false);
    for (const session of sessions)
      expect(
        session.recorder.sealedEvents.filter(
          (event) => event.kind === "oxagen:worktree_reconciled",
        ),
      ).toHaveLength(1);
  });

  it("starts with a malformed pending-end file without inventing a seal", async () => {
    const paths = scratchPaths();
    writeSensitiveFileAtomic(
      `${paths.root}/pending-session-ends.json`,
      "{broken",
    );
    const handle = await boot(
      fakeGit(() => REPO_ANSWERS, []),
      () => 1_000,
      undefined,
      undefined,
      undefined,
      paths,
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.tick();
    expect(handle.registry.get(SESSION)?.sealed).toBe(false);
  });

  it("preserves Cursor's explicit directory when SessionEnd carries only an inferred root", async () => {
    const handle = await boot(
      fakeGit(() => REPO_ANSWERS, []),
      () => 1_000,
    );
    await handle.api.handleHook({
      ...hook("SessionStart", { cwd: "/active" }),
      harness: "cursor",
    });
    await handle.api.handleHook({
      ...hook("SessionEnd", { cwd: "/fallback", cursor_cwd_inferred: true }),
      harness: "cursor",
    });
    expect(handle.registry.get(SESSION)?.cwd).toBe("/active");
    await handle.tick();
    expect(handle.registry.get(SESSION)?.sealed).toBe(true);
  });

  it("retries a pending final read after the Git lane fails while applying it", async () => {
    const handle = await boot(
      fakeGit(() => REPO_ANSWERS, []),
      () => 1_000,
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("SessionEnd"));
    const recorder = handle.registry.get(SESSION)!.recorder;
    const seal = recorder.sealCollectorEvent.bind(recorder);
    let fail = true;
    vi.spyOn(recorder, "sealCollectorEvent").mockImplementation((...args) => {
      if (fail && args[0] === "oxagen:worktree_reconciled") {
        fail = false;
        throw new Error("read application failed");
      }
      return seal(...args);
    });
    await handle.tick();
    expect(handle.registry.get(SESSION)?.sealed).toBe(false);
    await handle.tick();
    expect(handle.registry.get(SESSION)?.sealed).toBe(true);
    expect(reconciliations(handle)).toHaveLength(1);
  });

  it.each([false, true])(
    "retries the exact terminal event after a WAL failure, restart=%s",
    async (restart) => {
      const paths = scratchPaths();
      const exec = fakeGit(() => REPO_ANSWERS, []);
      const first = await boot(
        exec,
        () => 1000,
        undefined,
        undefined,
        undefined,
        paths,
      );
      await first.api.handleHook(hook("SessionStart"));
      await first.api.handleHook(hook("SessionEnd"));
      const append = first.wal.append.bind(first.wal);
      let expected: TachoEvent | undefined;
      const fault = vi
        .spyOn(first.wal, "append")
        .mockImplementation((events, bodies) => {
          const terminal = events.find(
            (event) =>
              event.kind === "agent_stop" && event.session_id === SESSION,
          );
          if (terminal !== undefined && expected === undefined) {
            expected = terminal;
            throw Object.assign(new Error("event disk full"), {
              code: "ENOSPC",
            });
          }
          append(events, bodies);
        });
      await first.tick();
      expect(expected).toBeDefined();
      expect(first.registry.get(SESSION)?.sealed).toBe(false);
      const uuid = first.registry.get(SESSION)!.recorder.sessionUuid;
      expect(
        first.wal.read(uuid).some((event) => event.kind === "agent_stop"),
      ).toBe(false);
      fault.mockRestore();
      let next = first;
      if (restart) {
        await first.stop();
        next = await boot(
          exec,
          () => 2000,
          undefined,
          undefined,
          undefined,
          paths,
        );
      }
      await next.tick();
      const stops = next.wal
        .read(uuid)
        .filter((event) => event.kind === "agent_stop");
      expect(stops).toEqual([expected]);
      expect(next.registry.get(SESSION)?.sealed).toBe(true);
    },
  );

  it("keeps a sibling session's reconciliation when an ending session's write fails", async () => {
    // Two sessions are reconciled in one tick. The sibling is reached first
    // and the ending session second, and the write that carries the ending
    // session's frame throws. The sibling's frame was computed before it, so
    // a shared batch handed it to the throwing call and lost it with nothing
    // to retry it; and both chains had already moved their cursors past
    // events the WAL never received.
    const handle = await boot(
      fakeGit(() => REPO_ANSWERS, []),
      () => 1_000,
    );
    await handle.api.handleHook(hook("SessionStart", { session_id: SIBLING }));
    await handle.api.handleHook(hook("Stop", { session_id: SIBLING }));
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("SessionEnd"));
    const sibling = handle.registry.get(SIBLING)!.recorder.sessionUuid;
    const endingChain = handle.registry.get(SESSION)!.recorder.sessionUuid;
    const append = handle.wal.append.bind(handle.wal);
    let failed = false;
    const fault = vi
      .spyOn(handle.wal, "append")
      .mockImplementation((events, bodies) => {
        if (
          !failed &&
          events.some(
            (event) =>
              event.kind === "oxagen:worktree_reconciled" &&
              event.session_uuid === endingChain,
          )
        ) {
          failed = true;
          throw Object.assign(new Error("event disk full"), { code: "ENOSPC" });
        }
        append(events, bodies);
      });
    await handle.tick();
    expect(failed).toBe(true);
    // The sibling's frame is on disk: it was written in its own call, before
    // the session whose write failed was reached.
    const siblingFrames = handle.wal.read(sibling);
    expect(
      siblingFrames.filter(
        (event) => event.kind === "oxagen:worktree_reconciled",
      ),
    ).toHaveLength(1);
    expect(seqs(siblingFrames)).toEqual(positions(siblingFrames));
    expect(handle.registry.get(SESSION)?.sealed).toBe(false);
    fault.mockRestore();
    await handle.tick();
    // The retry sealed at the sequence number the failed write abandoned, so
    // the closed chain holds one reconciliation and has no hole in it.
    const endingFrames = handle.wal.read(endingChain);
    expect(
      endingFrames.filter(
        (event) => event.kind === "oxagen:worktree_reconciled",
      ),
    ).toHaveLength(1);
    expect(seqs(endingFrames)).toEqual(positions(endingFrames));
    expect(handle.registry.get(SESSION)?.sealed).toBe(true);
    expect(seqs(handle.wal.read(sibling))).toEqual(
      positions(handle.wal.read(sibling)),
    );
  });

  it("refuses a checkpoint for a session whose terminal is stuck behind a WAL failure", async () => {
    // `sealed` reports `false` for the whole pending window (its terminal
    // is not durable yet), but that must not reopen the chain to a
    // checkpoint sealed in between: a checkpoint frame ahead of the stuck
    // terminal would fork the chain the next retry rebuilds against.
    const exec = fakeGit(() => REPO_ANSWERS, []);
    const handle = await boot(exec, () => 1000);
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("SessionEnd"));
    const append = handle.wal.append.bind(handle.wal);
    let expected: TachoEvent | undefined;
    let failuresLeft = 2;
    const fault = vi
      .spyOn(handle.wal, "append")
      .mockImplementation((events, bodies) => {
        const terminal = events.find(
          (event) =>
            event.kind === "agent_stop" && event.session_id === SESSION,
        );
        if (terminal !== undefined && failuresLeft > 0) {
          failuresLeft -= 1;
          expected = terminal;
          throw Object.assign(new Error("event disk full"), {
            code: "ENOSPC",
          });
        }
        append(events, bodies);
      });
    await handle.tick();
    const uuid = handle.registry.get(SESSION)!.recorder.sessionUuid;
    expect(handle.registry.get(SESSION)?.sealed).toBe(false);
    expect(handle.registry.get(SESSION)?.pendingTerminal).toBe(true);
    const cursorWhilePending =
      handle.registry.get(SESSION)!.recorder.chainCursor.seq;
    // This tick's own checkpoint (SessionEnd had not yet reached the git
    // lane) is legitimate; the count from here on is what must not move.
    const checkpointsWhilePending = handle.wal
      .read(uuid)
      .filter((event) => event.kind === "checkpoint").length;
    // checkpointMs: 0 makes every tick checkpoint-eligible. Before this fix,
    // `session.sealed === false` here read as "still live" and this tick
    // would seal a checkpoint frame ahead of the stuck terminal event.
    await handle.tick();
    expect(handle.registry.get(SESSION)?.sealed).toBe(false);
    expect(handle.registry.get(SESSION)?.pendingTerminal).toBe(true);
    expect(
      handle.wal.read(uuid).filter((event) => event.kind === "checkpoint"),
    ).toHaveLength(checkpointsWhilePending);
    expect(handle.registry.get(SESSION)!.recorder.chainCursor.seq).toBe(
      cursorWhilePending,
    );
    // The retry succeeds now, and the chain a checkpoint would have forked
    // still holds exactly the one terminal event, in its original position.
    await handle.tick();
    expect(
      handle.wal.read(uuid).filter((event) => event.kind === "agent_stop"),
    ).toEqual([expected]);
    expect(handle.registry.get(SESSION)?.sealed).toBe(true);
    expect(handle.registry.get(SESSION)?.pendingTerminal).toBe(false);
    fault.mockRestore();
  });

  it("does not duplicate a terminal event when only the WAL cursor write failed", async () => {
    const handle = await boot(
      fakeGit(() => REPO_ANSWERS, []),
      () => 1000,
    );
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("SessionEnd"));
    const append = handle.wal.append.bind(handle.wal);
    let failed = false;
    vi.spyOn(handle.wal, "append").mockImplementation((events, bodies) => {
      append(events, bodies);
      if (
        !failed &&
        events.some(
          (event) =>
            event.kind === "agent_stop" && event.session_id === SESSION,
        )
      ) {
        failed = true;
        throw new Error("cursor write failed");
      }
    });
    await handle.tick();
    expect(handle.registry.get(SESSION)?.sealed).toBe(false);
    await handle.tick();
    const uuid = handle.registry.get(SESSION)!.recorder.sessionUuid;
    expect(
      handle.wal.read(uuid).filter((event) => event.kind === "agent_stop"),
    ).toHaveLength(1);
    expect(handle.registry.get(SESSION)?.sealed).toBe(true);
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
          // Proof of "unborn", not just "failed": HEAD still resolves
          // symbolically to the branch the repository will have once it
          // commits, and that branch's ref has never been written. Neither
          // `rev-parse --verify HEAD` nor `show-ref` gets an answer here, so
          // both fall through to the harness's unmatched-command default
          // (exit 1), which is what a real unborn repository also answers.
          "symbolic-ref -q HEAD": "refs/heads/main\n",
          // The empty-tree diff the unborn path falls back to once it has
          // that proof. No tracked file exists yet, so it reports nothing;
          // the untracked create below still comes from `status`.
          "diff --numstat 4b825dc642cb6eb9a060e54bf8d69288fbee4904": "",
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
