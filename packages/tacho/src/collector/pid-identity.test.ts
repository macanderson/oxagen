/**
 * A session's pid names its harness only while the harness runs. Once it
 * exits, the OS hands the pid to the next process it starts, so the kill path
 * and the sweep check the process's start time against the one recorded when
 * a live hook first named the pid (#4314).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import { readHostFile, writeHostFile } from "../host/host-file";
import {
  procStartTicks,
  readProcessStarts,
  readProcessStartsAsync,
} from "../host/process-scan";
import type { Exec } from "../host/service";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { DeliveredCommand } from "../wire";
import { type DaemonHandle, startDaemon } from "./daemon";
import { applyCommands, type InboxDeps } from "./inbox";
import { SessionRegistry } from "./registry";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

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

function command(overrides: Partial<DeliveredCommand>): DeliveredCommand {
  return {
    id: "cmd",
    command: "cancel",
    session_uuid: null,
    payload: {},
    requested_mode: null,
    delivery_mode: null,
    degraded_reason: null,
    reason: null,
    issued_at: "2026-09-25T10:00:00.000Z",
    expires_at: null,
    ...overrides,
  };
}

/** A process table the test edits: pid to start time. */
function processTable(entries: Record<number, string>) {
  const table = new Map<number, string>(
    Object.entries(entries).map(([pid, at]) => [Number(pid), at]),
  );
  const reads: number[][] = [];
  const processStarts = (pids: readonly number[]) => {
    reads.push([...pids]);
    return new Map(
      pids
        .filter((pid) => table.has(pid))
        .map((pid): [number, string] => [pid, table.get(pid) as string]),
    );
  };
  return { table, reads, processStarts };
}

function inboxSetup(options: {
  processStarts?: (pids: readonly number[]) => ReadonlyMap<number, string>;
}) {
  const now = () => Date.parse("2026-09-25T10:00:00.000Z");
  const registry = new SessionRegistry({
    context: CONTEXT,
    scope: TEST_ENROLLMENT,
    now,
    ...(options.processStarts !== undefined
      ? { processStarts: options.processStarts }
      : {}),
  });
  const host = registry.ensure("tachod-boot", { pid: process.pid }).record;
  host.recorder.sealCollectorEvent("agent_start", {
    session_start_source: "daemon",
  });
  const agent = registry.ensure("sess-1", { pid: 4242 }).record;
  agent.recorder.sealCollectorEvent("agent_start", {
    session_start_source: "startup",
  });
  const kills: string[] = [];
  const deps: InboxDeps = {
    registry,
    hostRecorder: () => host.recorder,
    kill: (pid, signal) => {
      kills.push(`${pid}:${signal}`);
      return true;
    },
    refreshBundle: async () => undefined,
    onHostSuspended: () => undefined,
    now,
  };
  return { registry, agent, kills, deps };
}

describe("an operator cancel", () => {
  it("sends no signal when the pid now names a process that started later", async () => {
    const table = processTable({ 4242: STARTED });
    const { agent, kills, deps } = inboxSetup({
      processStarts: table.processStarts,
    });
    expect(agent.pidInstance).toBe(STARTED);
    // The harness exited and the OS gave 4242 to another process.
    table.table.set(4242, LATER);
    const result = await applyCommands(
      [command({ id: "c", session_uuid: agent.recorder.sessionUuid })],
      {
        ...deps,
        processStart: (pid) => table.processStarts([pid]).get(pid),
      },
    );
    expect(kills).toEqual([]);
    const attempt = result.events.find(
      (event) => event.kind === "oxagen:kill_attempted",
    );
    expect(attempt?.body).toMatchObject({ kill_outcome: "no_pid" });
    expect(attempt?.attrs).toMatchObject({
      "process.pid": "4242",
      "process.pid_reused": "1",
    });
    expect(result.acknowledgements).toEqual([
      expect.objectContaining({
        command_id: "c",
        status: "failed",
        detail:
          "SIGTERM was not delivered (no_pid: pid 4242 now names another process)",
      }),
    ]);
  });

  it("signals the pid while it names the process the session recorded", async () => {
    const table = processTable({ 4242: STARTED });
    const { agent, kills, deps } = inboxSetup({
      processStarts: table.processStarts,
    });
    const result = await applyCommands(
      [
        command({
          id: "k",
          command: "kill",
          session_uuid: agent.recorder.sessionUuid,
        }),
      ],
      {
        ...deps,
        processStart: (pid) => table.processStarts([pid]).get(pid),
      },
    );
    expect(kills).toEqual(["4242:SIGKILL"]);
    expect(result.acknowledgements[0]?.status).toBe("applied");
  });

  it("signals the bare pid where no start time was recorded, as on Windows", async () => {
    // Windows has no `ps`, so the reader answers nothing and no start time
    // is recorded. The signal goes to the pid the harness reported.
    const { agent, kills, deps } = inboxSetup({
      processStarts: (pids) =>
        readProcessStarts(
          pids,
          () => {
            throw new Error("no ps on Windows");
          },
          "win32",
        ) ?? new Map(),
    });
    expect(agent.pidInstance).toBeUndefined();
    await applyCommands(
      [command({ id: "c", session_uuid: agent.recorder.sessionUuid })],
      { ...deps, processStart: () => LATER },
    );
    expect(kills).toEqual(["4242:SIGTERM"]);
  });
});

describe("the recorded start time", () => {
  it("is read once per pid, only for a live hook, and again when the pid changes", () => {
    const table = processTable({ 4242: STARTED, 5151: LATER });
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: () => Date.parse("2026-09-25T10:00:00.000Z"),
      processStarts: table.processStarts,
    });
    // A replayed hook may come from a harness that is gone: no read.
    const { record } = registry.ensure("sess-1", {
      pid: 4242,
      seenAt: "2026-09-25T09:59:00.000Z",
    });
    expect(record.pidInstance).toBeUndefined();
    registry.ensure("sess-1", { pid: 4242 });
    registry.ensure("sess-1", { pid: 4242 });
    expect(record.pidInstance).toBe(STARTED);
    expect(table.reads).toEqual([[4242]]);
    registry.ensure("sess-1", { pid: 5151 });
    expect(record.pidInstance).toBe(LATER);
    expect(table.reads).toEqual([[4242], [5151]]);
    // The daemon's own chain names this process and is never read.
    registry.ensure("tachod-boot", { pid: process.pid });
    expect(table.reads).toHaveLength(2);
  });

  it("goes with the pid through the state file", () => {
    const table = processTable({ 4242: STARTED });
    const options = {
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: () => Date.parse("2026-09-25T10:00:00.000Z"),
    };
    const registry = new SessionRegistry({
      ...options,
      processStarts: table.processStarts,
    });
    registry.ensure("sess-1", { pid: 4242 });
    const restored = new SessionRegistry(options);
    restored.restore(JSON.parse(JSON.stringify(registry.state())));
    expect(restored.get("sess-1")?.pidInstance).toBe(STARTED);
  });

  it("is read again when a resume reopens the session under the same pid", () => {
    const table = processTable({ 4242: STARTED });
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: () => Date.parse("2026-09-25T10:00:00.000Z"),
      processStarts: table.processStarts,
    });
    const { record } = registry.ensure("sess-1", {
      pid: 4242,
      lastHookEvent: "SessionStart",
    });
    expect(record.pidInstance).toBe(STARTED);
    registry.seal(record);
    // The resumed harness is a new process that got the same pid.
    table.table.set(4242, LATER);
    const resumed = registry.ensure("sess-1", {
      pid: 4242,
      lastHookEvent: "SessionStart",
    });
    expect(resumed.reopened).toBe(true);
    expect(record.pidInstance).toBe(LATER);
    const alive = (pid: number, instance?: string) =>
      instance === undefined || table.table.get(pid) === instance;
    expect(registry.sweepCandidates(alive, 60 * 60_000)).toEqual([]);
  });
});

describe("readProcessStarts", () => {
  it("reads every pid with one ps call", () => {
    const calls: string[][] = [];
    const exec: Exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      return {
        status: 0,
        stdout: `  4242 ${STARTED}    \n 5151 ${LATER}\n 9 junk\n`,
        stderr: "",
      };
    };
    expect(readProcessStarts([4242, 5151], exec, "darwin")).toEqual(
      new Map([
        [4242, STARTED],
        [5151, LATER],
      ]),
    );
    expect(calls).toEqual([["ps", "-o", "pid=,lstart=", "-p", "4242,5151"]]);
  });

  it("answers an empty listing when no pid names a process, and nothing when ps fails", () => {
    expect(
      readProcessStarts(
        [4242],
        () => ({ status: 1, stdout: "", stderr: "" }),
        "darwin",
      ),
    ).toEqual(new Map());
    expect(
      readProcessStarts(
        [4242],
        () => ({ status: null, stdout: "", stderr: "" }),
        "darwin",
      ),
    ).toBeUndefined();
  });

  it("reads the same way without holding the event loop", async () => {
    const calls: string[][] = [];
    const started = await readProcessStartsAsync(
      [4242, 5151],
      async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { status: 0, stdout: `4242 ${STARTED}\n`, stderr: "" };
      },
      "darwin",
    );
    expect(started).toEqual(new Map([[4242, STARTED]]));
    expect(calls).toEqual([["ps", "-o", "pid=,lstart=", "-p", "4242,5151"]]);
  });

  const BOOT = "9f0c2b7e-51a4-4a4e-8d0b-3c1e7f2a6b90";
  /** A `/proc/<pid>/stat` line whose command name holds spaces and parentheses. */
  const stat = (pid: number, ticks: number) =>
    `${pid} (tacho (hook) x) S 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 4 0 ${ticks} 12345678 900 18446744073709551615\n`;

  it("counts /proc/<pid>/stat fields from the last parenthesis", () => {
    expect(procStartTicks(stat(4242, 98765))).toBe("98765");
    expect(procStartTicks("4242 (claude) S 1")).toBeUndefined();
    expect(procStartTicks("garbage")).toBeUndefined();
  });

  it("reads the boot id and start ticks from /proc on Linux, so a clock step leaves the value alone", () => {
    // procps prints lstart as the boot time plus the start ticks, and the
    // kernel moves the boot time when the wall clock is stepped. Each `ps`
    // here answers as it would after a step; none of it may reach the value.
    let step = 0;
    const exec: Exec = () => {
      step += 1;
      return {
        status: 0,
        stdout: `4242 Fri Sep 25 09:00:0${step} 2026\n`,
        stderr: "",
      };
    };
    const files: Record<string, string> = {
      "/proc/sys/kernel/random/boot_id": `${BOOT}\n`,
      "/proc/4242/stat": stat(4242, 98765),
    };
    const read = (path: string) => files[path];
    const first = readProcessStarts([4242, 5151], exec, "linux", read);
    const second = readProcessStarts([4242, 5151], exec, "linux", read);
    expect(first).toEqual(new Map([[4242, `${BOOT}:98765`]]));
    expect(second).toEqual(first);
    expect(step).toBe(0);
    // With no boot id there is nothing to tell one boot's ticks from the
    // next, so nothing is answered and the bare pid stands.
    expect(
      readProcessStarts([4242], exec, "linux", (path) =>
        path.endsWith("boot_id") ? undefined : files[path],
      ),
    ).toBeUndefined();
  });

  it.runIf(process.platform === "linux")(
    "reads this process's start from the real /proc, the same across two reads",
    async () => {
      vi.mocked(spawnSync).mockClear();
      const first = readProcessStarts([process.pid])?.get(process.pid);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const second = readProcessStarts([process.pid])?.get(process.pid);
      expect(first).toMatch(/^[0-9a-f-]{36}:\d+$/);
      expect(second).toBe(first);
      const ticks = procStartTicks(readFileSync("/proc/self/stat", "utf8"));
      expect(first?.endsWith(`:${ticks}`)).toBe(true);
      expect(
        vi.mocked(spawnSync).mock.calls.some(([command]) => command === "ps"),
      ).toBe(false);
    },
  );

  it.runIf(process.platform === "darwin")(
    "reads this process's start time from a real ps, in UTC and the C locale",
    () => {
      const started = readProcessStarts([process.pid])?.get(process.pid);
      expect(started).toBeDefined();
      const call = vi
        .mocked(spawnSync)
        .mock.calls.find(([command]) => command === "ps");
      expect(call?.[2]?.env?.["TZ"]).toBe("UTC");
      expect(call?.[2]?.env?.["LC_ALL"]).toBe("C");
      expect(call?.[2]?.env?.["LANG"]).toBe("C");
      const at = Date.parse(`${started} UTC`);
      const expected = Date.now() - process.uptime() * 1_000;
      expect(Math.abs(at - expected)).toBeLessThan(5_000);
    },
  );

  it("answers nothing on Windows without running anything", () => {
    let ran = false;
    expect(
      readProcessStarts(
        [4242],
        () => {
          ran = true;
          return { status: 0, stdout: `4242 ${STARTED}`, stderr: "" };
        },
        "win32",
      ),
    ).toBeUndefined();
    expect(ran).toBe(false);
  });
});

describe("the daemon's sweep", () => {
  const SESSION = "11111111-2222-3333-4444-555555555555";
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(
    processStarts: (pids: readonly number[]) => ReadonlyMap<number, string>,
    paths = scratchPaths(),
  ) {
    const signer = bundleSigner();
    const bundle = signer.sign(unsignedBundle());
    writeHostFile(
      paths.hostFile,
      readHostFile(paths.hostFile) ?? testHostFile(signer, bundle),
    );
    const handle = await startDaemon({
      paths,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      exec: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      processStarts,
      now: () => 1_000,
      log: () => {},
      listen: false,
      transcriptRoots: [`${paths.root}/no-transcripts`],
      timers: {
        detectorMs: 60 * 60_000,
        sweepMs: 0,
        checkpointMs: 60 * 60_000,
        commandsPollMs: 0,
      },
    });
    handles.push(handle);
    return { handle, paths };
  }

  // A pid that answers `kill(pid, 0)` for the whole test: this process.
  const pid = process.pid;
  const hook = {
    payload: { session_id: SESSION, hook_event_name: "SessionStart" },
    env: { CLAUDE_PID: String(pid) },
  };

  it("closes a session whose pid answers but names a process that started later", async () => {
    const table = processTable({ [pid]: STARTED });
    const { handle } = await boot(table.processStarts);
    await handle.api.handleHook(hook);
    const record = handle.registry.get(SESSION)!;
    expect(record.pidInstance).toBe(STARTED);
    await handle.tick();
    expect(record.sealed).toBe(false);

    table.table.set(pid, LATER);
    await handle.tick();
    expect(record.sealed).toBe(true);
    expect(handle.wal.read(record.recorder.sessionUuid).at(-1)?.kind).toBe(
      "agent_stop",
    );
  });

  it("keeps a resumed session open when its new process got the old pid", async () => {
    const table = processTable({ [pid]: STARTED });
    const { handle } = await boot(table.processStarts);
    await handle.api.handleHook(hook);
    await handle.api.handleHook({
      payload: {
        session_id: SESSION,
        hook_event_name: "SessionEnd",
        reason: "prompt_input_exit",
      },
      env: { CLAUDE_PID: String(pid) },
    });
    await handle.tick();
    const record = handle.registry.get(SESSION)!;
    expect(record.sealed).toBe(true);

    // The harness resumes in a new process, and the OS hands it the same pid.
    table.table.set(pid, LATER);
    await handle.api.handleHook({
      payload: {
        session_id: SESSION,
        hook_event_name: "SessionStart",
        source: "resume",
      },
      env: { CLAUDE_PID: String(pid) },
    });
    expect(record.sealed).toBe(false);
    expect(record.pidInstance).toBe(LATER);
    await handle.tick();
    expect(record.sealed).toBe(false);
  });

  it("keeps the start time across a restart", async () => {
    const table = processTable({ [pid]: STARTED });
    const first = await boot(table.processStarts);
    await first.handle.api.handleHook(hook);
    await first.handle.stop();
    const second = await boot(() => new Map(), first.paths);
    expect(second.handle.registry.get(SESSION)?.pidInstance).toBe(STARTED);
  });
});
