/**
 * A live hook that first names a pid reads when that process started. On
 * macOS the read is a `ps` call, and it ran with `spawnSync` for up to two
 * seconds inside the hook queue, so every hook on the host and the model
 * proxy's streams waited on it (#4366). The read now answers later, and the
 * registry records the start time when it lands.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import { readHostFile, writeHostFile } from "../host/host-file";
import type { ExecResult } from "../host/service";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type DaemonHandle, startDaemon } from "./daemon";
import { SessionRegistry } from "./registry";

const CONTEXT: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cc-laptop",
    fleet_id: "wrk_1",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
    host_enrollment_id: TEST_ENROLLMENT,
  },
};

const STARTED = "Fri Sep 25 09:00:00 2026";
const LATER = "Fri Sep 25 11:30:00 2026";

/** Let every promise callback that is ready run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A start-time reader whose answers the test gives, one read at a time. */
function pendingReads() {
  const reads: Array<{
    pids: number[];
    answer: (starts: ReadonlyMap<number, string> | undefined) => void;
  }> = [];
  const processStarts = (pids: readonly number[]) =>
    new Promise<ReadonlyMap<number, string> | undefined>((resolve) => {
      reads.push({ pids: [...pids], answer: resolve });
    });
  return { reads, processStarts };
}

function registryWith(
  processStarts: ReturnType<typeof pendingReads>["processStarts"],
) {
  return new SessionRegistry({
    context: CONTEXT,
    scope: TEST_ENROLLMENT,
    now: () => Date.parse("2026-09-25T10:00:00.000Z"),
    processStarts,
  });
}

describe("a start time read that answers later", () => {
  it("lands on the session once the read answers", async () => {
    const pending = pendingReads();
    const registry = registryWith(pending.processStarts);
    const { record } = registry.ensure("sess-1", { pid: 4242 });
    // `ensure` returned before the read answered.
    expect(record.pid).toBe(4242);
    expect(record.pidInstance).toBeUndefined();
    // The same pid again starts no second read.
    registry.ensure("sess-1", { pid: 4242 });
    expect(pending.reads.map((read) => read.pids)).toEqual([[4242]]);
    pending.reads[0]?.answer(new Map([[4242, STARTED]]));
    await settle();
    expect(record.pidInstance).toBe(STARTED);
  });

  it("drops an answer for a pid the session no longer names", async () => {
    const pending = pendingReads();
    const registry = registryWith(pending.processStarts);
    const { record } = registry.ensure("sess-1", { pid: 4242 });
    registry.ensure("sess-1", { pid: 5151 });
    expect(pending.reads.map((read) => read.pids)).toEqual([[4242], [5151]]);
    pending.reads[0]?.answer(new Map([[4242, STARTED]]));
    await settle();
    expect(record.pidInstance).toBeUndefined();
    pending.reads[1]?.answer(new Map([[5151, LATER]]));
    await settle();
    expect(record.pidInstance).toBe(LATER);
  });

  it("drops an answer a resume replaced, though the pid is the same", async () => {
    const pending = pendingReads();
    const registry = registryWith(pending.processStarts);
    const { record } = registry.ensure("sess-1", {
      pid: 4242,
      lastHookEvent: "SessionStart",
    });
    registry.seal(record);
    // The harness resumes in a new process that got the same pid, before
    // the first read answers.
    const resumed = registry.ensure("sess-1", {
      pid: 4242,
      lastHookEvent: "SessionStart",
    });
    expect(resumed.reopened).toBe(true);
    expect(pending.reads).toHaveLength(2);
    // The first read found the process that held the pid before the resume.
    pending.reads[0]?.answer(new Map([[4242, STARTED]]));
    await settle();
    expect(record.pidInstance).toBeUndefined();
    pending.reads[1]?.answer(new Map([[4242, LATER]]));
    await settle();
    expect(record.pidInstance).toBe(LATER);
  });

  it("records nothing when the read fails, and keeps the bare pid", async () => {
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: () => Date.parse("2026-09-25T10:00:00.000Z"),
      processStarts: () => Promise.reject(new Error("ps went away")),
    });
    const { record } = registry.ensure("sess-1", { pid: 4242 });
    await settle();
    expect(record.pid).toBe(4242);
    expect(record.pidInstance).toBeUndefined();
    // With no start time the sweep keeps the plain liveness answer.
    expect(registry.sweepCandidates(() => true, 60 * 60_000)).toEqual([]);
  });
});

describe("the daemon on macOS", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  const FIRST = "11111111-2222-3333-4444-555555555555";
  const SECOND = "66666666-7777-8888-9999-000000000000";
  const NOT_A_REPOSITORY: ExecResult = {
    status: 128,
    stdout: "",
    stderr: "not a repository",
  };

  it("answers another hook while ps reads the first hook's pid (#4366)", async () => {
    const paths = scratchPaths();
    const signer = bundleSigner();
    writeHostFile(
      paths.hostFile,
      readHostFile(paths.hostFile) ??
        testHostFile(signer, signer.sign(unsignedBundle())),
    );
    // A `ps` that answers only when the test says so: as slow as it needs.
    const psReads: Array<{
      args: string[];
      answer: (stdout: string) => void;
    }> = [];
    const handle = await startDaemon({
      paths,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      exec: () => NOT_A_REPOSITORY,
      execAsync: (command, args) =>
        command === "ps"
          ? new Promise<ExecResult>((resolve) => {
              psReads.push({
                args,
                answer: (stdout) => resolve({ status: 0, stdout, stderr: "" }),
              });
            })
          : Promise.resolve(NOT_A_REPOSITORY),
      platform: "darwin",
      now: () => 1_000,
      log: () => {},
      listen: false,
      transcriptRoots: [`${paths.tachoDir}/no-transcripts`],
      timers: {
        detectorMs: 60 * 60_000,
        sweepMs: 60 * 60_000,
        checkpointMs: 60 * 60_000,
        commandsPollMs: 0,
      },
    });
    handles.push(handle);
    const pid = process.pid;

    await handle.api.handleHook({
      payload: { session_id: FIRST, hook_event_name: "SessionStart" },
      env: { CLAUDE_PID: String(pid) },
    });
    const first = handle.registry.get(FIRST);
    expect(first?.pid).toBe(pid);
    expect(psReads.map((read) => read.args)).toEqual([
      ["-o", "pid=,lstart=", "-p", String(pid)],
    ]);
    expect(first?.pidInstance).toBeUndefined();

    // `ps` has not answered, and the next hook is answered anyway.
    await handle.api.handleHook({
      payload: { session_id: SECOND, hook_event_name: "SessionStart" },
      env: {},
    });
    expect(handle.registry.get(SECOND)).toBeDefined();
    expect(first?.pidInstance).toBeUndefined();

    psReads[0]?.answer(`${pid} ${STARTED}\n`);
    await settle();
    expect(first?.pidInstance).toBe(STARTED);
    expect(psReads).toHaveLength(1);
  });
});
