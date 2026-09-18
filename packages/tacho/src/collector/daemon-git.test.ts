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
import { afterEach, describe, expect, it } from "vitest";
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
  "status --porcelain=v1 -z": " M src/a.ts\0?? src/new.ts\0",
  "status --porcelain": " M src/a.ts\n",
  "remote get-url origin": "git@github.com:acme/repo.git\n",
  "diff --numstat HEAD": "4\t1\tsrc/a.ts\n",
  "rev-parse --show-toplevel": `${CWD}\n`,
  // The untracked probe: `--no-index` exits 1 to say the inputs differ.
  "--no-index": "27\t0\t/dev/null => /repo/src/new.ts\n",
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
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      exec,
      ...(execAsync !== undefined ? { execAsync } : {}),
      now,
      log: () => undefined,
      listen: false,
      transcriptRoots: [`${paths.root}/no-transcripts`],
      timers: { detectorMs: 0, sweepMs: 0, checkpointMs: 0, commandsPollMs: 0 },
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
    // Let the tick reach its first git command and block there.
    await new Promise((resolve) => setTimeout(resolve, 0));
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
      hook("PostToolUse", { tool_name: "Read", tool_input: { file_path: "a" } }),
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
    // It did not even reach for the worktree: the facts read said no repo.
    expect(
      calls.some((call) => call.join(" ").includes("--porcelain=v1 -z")),
    ).toBe(false);
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
