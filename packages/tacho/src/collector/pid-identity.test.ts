/**
 * A session's pid names its harness only while the harness runs. Once it
 * exits, the OS hands the pid to the next process it starts, so the kill path
 * and the sweep check the process's start time against the one recorded when
 * a live hook first named the pid (#4314).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import { readHostFile, writeHostFile } from "../host/host-file";
import { readProcessStarts } from "../host/process-scan";
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
        "linux",
      ),
    ).toEqual(new Map());
    expect(
      readProcessStarts(
        [4242],
        () => ({ status: null, stdout: "", stderr: "" }),
        "linux",
      ),
    ).toBeUndefined();
  });

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

  it("keeps the start time across a restart", async () => {
    const table = processTable({ [pid]: STARTED });
    const first = await boot(table.processStarts);
    await first.handle.api.handleHook(hook);
    await first.handle.stop();
    const second = await boot(() => new Map(), first.paths);
    expect(second.handle.registry.get(SESSION)?.pidInstance).toBe(STARTED);
  });
});
