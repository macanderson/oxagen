/**
 * A chain the daemon reopens must continue the chain its WAL already holds.
 *
 * `daemon.json` is written at tick end, so a crash can lose the record of a
 * session, or of a subagent under it, that the WAL already holds events for.
 * The next hook for that session opened a recorder at seq 0 over a file that
 * held seq 0 onward. On 2026-09-24 that left one host with a session end
 * that could never land, retried about once a second for four hours ("WAL
 * recovery conflict at 42d59064…:6"), and a subagent whose every transcript
 * line was refused and sealed a gap of its own, 608 gaps in one second.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { ClaudeCodeContext } from "../claude-code/context";
import { SessionRecorder } from "../claude-code/recorder";
import type { TachoEvent } from "../envelope";
import { writeSensitiveFileAtomic } from "../host/fs";
import { readHostFile, writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type DaemonHandle, startDaemon } from "./daemon";
import { parseRegistryState } from "./registry";

const SESSION = "11111111-2222-3333-4444-555555555555";
const CWD = "/repo";

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

/** A subagent's tool request, which opens or continues its own chain. */
function subagentRead(agentId: string, toolUseId: string) {
  return hook("PreToolUse", {
    agent_id: agentId,
    agent_type: "general-purpose",
    tool_name: "Read",
    tool_input: { file_path: "/repo/a.ts" },
    tool_use_id: toolUseId,
  });
}

function gaps(events: readonly TachoEvent[]): TachoEvent[] {
  return events.filter((event) => event.kind === "telemetry_gap");
}

describe("a chain reopened over its own WAL", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(
    paths: ReturnType<typeof scratchPaths>,
    now: () => number = () => 1_000,
    log: string[] = [],
  ): Promise<DaemonHandle> {
    const signer = bundleSigner();
    const bundle = signer.sign(
      unsignedBundle({
        permissions: { allow: ["Read"], deny: [], ask: [] },
      }),
    );
    const host = readHostFile(paths.hostFile) ?? testHostFile(signer, bundle);
    writeHostFile(paths.hostFile, host);
    const handle = await startDaemon({
      paths,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      // No repository here: every git probe fails, so a SessionEnd settles
      // on the first tick.
      exec: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      now,
      log: (line) => log.push(line),
      listen: false,
      transcriptRoots: [`${paths.root}/no-transcripts`],
      timers: {
        detectorMs: 0,
        sweepMs: 60 * 60_000,
        checkpointMs: 60 * 60_000,
        commandsPollMs: 0,
      },
    });
    handles.push(handle);
    return handle;
  }

  async function restartWithoutState(
    paths: ReturnType<typeof scratchPaths>,
    handle: DaemonHandle,
  ): Promise<DaemonHandle> {
    await handle.stop();
    handles.splice(handles.indexOf(handle), 1);
    // The persist that would have named the session never landed.
    rmSync(paths.daemonState);
    return boot(paths);
  }

  it("continues a session's chain when the state file never named it", async () => {
    const paths = scratchPaths();
    const first = await boot(paths);
    await first.api.handleHook(hook("SessionStart"));
    await first.api.handleHook(hook("Stop"));
    const uuid = first.registry.get(SESSION)!.recorder.sessionUuid;
    const before = first.wal.read(uuid).length;
    expect(before).toBeGreaterThan(1);

    const second = await restartWithoutState(paths, first);
    await second.api.handleHook(hook("UserPromptSubmit", { prompt: "again" }));
    await second.api.handleHook(hook("Stop"));

    const chain = second.wal.read(uuid);
    expect(chain.length).toBeGreaterThan(before);
    expect(verifyChain(chain, { expectGenesis: true })).toMatchObject({
      ok: true,
    });
  });

  it("puts a reopened chain back where the WAL ends when its first write fails", async () => {
    const paths = scratchPaths();
    const first = await boot(paths);
    await first.api.handleHook(hook("SessionStart"));
    const uuid = first.registry.get(SESSION)!.recorder.sessionUuid;

    const second = await restartWithoutState(paths, first);
    const append = second.wal.append.bind(second.wal);
    second.wal.append = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    await expect(second.api.handleHook(hook("Stop"))).rejects.toThrow(
      /ENOSPC/,
    );
    second.wal.append = append;
    await second.api.handleHook(hook("Stop"));

    expect(
      verifyChain(second.wal.read(uuid), { expectGenesis: true }),
    ).toMatchObject({ ok: true });
  });

  it("continues a subagent's chain, with no second genesis and no gap on its parent", async () => {
    const paths = scratchPaths();
    const first = await boot(paths);
    await first.api.handleHook(hook("SessionStart"));
    await first.api.handleHook(subagentRead("sub-1", "toolu_1"));
    const root = first.registry.get(SESSION)!.recorder;
    const child = root.openChildren.get("sub-1")!.sessionUuid;
    const before = first.wal.read(child).length;
    expect(before).toBeGreaterThan(0);

    const second = await restartWithoutState(paths, first);
    await second.api.handleHook(subagentRead("sub-1", "toolu_2"));

    const chain = second.wal.read(child);
    expect(chain.length).toBeGreaterThan(before);
    expect(verifyChain(chain, { expectGenesis: true })).toMatchObject({
      ok: true,
    });
    expect(chain.filter((event) => event.kind === "agent_start")).toHaveLength(
      1,
    );
    expect(gaps(second.wal.read(root.sessionUuid))).toEqual([]);
  });

  it("sets aside a session end sealed on another chain once, and seals the end on the chain the WAL holds", async () => {
    const paths = scratchPaths();
    const first = await boot(paths);
    await first.api.handleHook(hook("SessionStart"));
    await first.api.handleHook(hook("UserPromptSubmit", { prompt: "go" }));
    await first.api.handleHook(hook("Stop"));
    const record = first.registry.get(SESSION)!;
    const uuid = record.recorder.sessionUuid;
    const onDisk = first.wal.read(uuid);
    expect(onDisk.length).toBeGreaterThanOrEqual(3);
    await first.stop();
    handles.splice(0);

    // The terminal a recorder opened at genesis over this file sealed: an
    // agent_stop at seq 2, hashed onto a chain the WAL never held.
    const persisted = parseRegistryState(
      JSON.parse(readFileSync(paths.daemonState, "utf8")),
    )!;
    const saved = persisted.sessions.find(
      (session) => session.harnessSessionId === SESSION,
    )!;
    const fork = new SessionRecorder({
      context: {
        agent: onDisk[0]!.agent as ClaudeCodeContext["agent"],
        now: () => 1_000,
      },
      harnessSessionId: SESSION,
      scope: TEST_ENROLLMENT,
      restore: {
        ...saved.recorder,
        cursor: { seq: 2, prevHash: `sha256:${"f".repeat(64)}` },
      },
    });
    const stop = fork.sealCollectorEvent("agent_stop", {
      session_outcome: "completed",
    });
    expect(stop.seq).toBe(2);
    expect(stop.hash).not.toBe(onDisk[2]!.hash);
    writeSensitiveFileAtomic(
      paths.pendingEnds,
      JSON.stringify([
        [
          uuid,
          {
            payload: {
              session_id: SESSION,
              hook_event_name: "SessionEnd",
              cwd: CWD,
              reason: "other",
            },
            replay: {
              receivedAt: new Date(1_000).toISOString(),
              deferred: true,
            },
            terminal: {
              events: [stop],
              state: {
                ...persisted,
                sessions: [{ ...saved, recorder: fork.state() }],
                agents: [],
              },
              bodies: [],
            },
          },
        ],
      ]),
    );

    const log: string[] = [];
    const second = await boot(paths, () => 2_000, log);
    for (let tick = 0; tick < 3; tick += 1) await second.tick();

    expect(log.filter((line) => line.startsWith("git reads failed"))).toEqual(
      [],
    );
    expect(
      log.filter((line) => line.includes("conflicts with the WAL")),
    ).toHaveLength(1);
    const setAside = readdirSync(paths.quarantine).filter((name) =>
      name.startsWith(uuid),
    );
    expect(setAside).toHaveLength(1);
    const kept = JSON.parse(
      readFileSync(join(paths.quarantine, setAside[0]!), "utf8"),
    ) as { events: TachoEvent[] };
    expect(kept.events.map((event) => event.hash)).toEqual([stop.hash]);

    expect(second.registry.get(SESSION)?.sealed).toBe(true);
    const chain = second.wal.read(uuid);
    expect(verifyChain(chain, { expectGenesis: true })).toMatchObject({
      ok: true,
    });
    expect(chain.slice(0, onDisk.length)).toEqual(onDisk);
    expect(chain.at(-1)?.kind).toBe("agent_stop");
    expect(JSON.parse(readFileSync(paths.pendingEnds, "utf8"))).toEqual([]);
  });

  describe("the spool's outage gap", () => {
    function spool(
      paths: ReturnType<typeof scratchPaths>,
      name: string,
      receivedAt: number,
      payload: ReturnType<typeof hook>["payload"],
    ): void {
      mkdirSync(paths.spool, { recursive: true });
      writeFileSync(
        join(paths.spool, `${name}.json`),
        JSON.stringify({
          schema: "tacho.spool.v1",
          received_at: new Date(receivedAt).toISOString(),
          hook_id: name,
          payload,
          env: {},
        }),
      );
    }

    it("seals no gap for a hook spooled while this daemon was serving", async () => {
      const paths = scratchPaths();
      let time = 10_000;
      const handle = await boot(paths, () => time);
      await handle.api.handleHook(hook("SessionStart"));
      // A hook the daemon answered with an error, or too slowly: the client
      // spooled it, but nothing the daemon receives directly was lost.
      time = 11_000;
      spool(paths, "01-late", time, hook("Stop").payload);
      time = 12_000;
      await handle.drainSpool();
      const uuid = handle.registry.get(SESSION)!.recorder.sessionUuid;
      expect(gaps(handle.wal.read(uuid))).toEqual([]);
    });

    it("seals one gap for one outage, however many drains replay it", async () => {
      const paths = scratchPaths();
      const first = await boot(paths, () => 1_000);
      await first.api.handleHook(hook("SessionStart"));
      const uuid = first.registry.get(SESSION)!.recorder.sessionUuid;
      await first.stop();
      handles.splice(0);
      // Spooled while no daemon ran.
      spool(paths, "01-down", 2_000, hook("UserPromptSubmit", { prompt: "a" }).payload);
      spool(paths, "02-down", 3_000, hook("Stop").payload);

      const second = await boot(paths, () => 5_000);
      await second.drainSpool();
      spool(paths, "03-down", 4_000, hook("Stop").payload);
      await second.drainSpool();

      expect(existsSync(join(paths.spool, "03-down.json"))).toBe(false);
      const outage = gaps(second.wal.read(uuid));
      expect(outage).toHaveLength(1);
      expect(outage[0]!.body).toMatchObject({ gap_cause: "daemon_down" });
    });

    it("seals one gap across drains for a session only the spool knew of", async () => {
      const paths = scratchPaths();
      spool(paths, "01-down", 2_000, hook("SessionStart").payload);
      spool(paths, "02-down", 3_000, hook("Stop").payload);
      const handle = await boot(paths, () => 5_000);
      await handle.drainSpool();
      spool(paths, "03-down", 4_000, hook("Stop").payload);
      await handle.drainSpool();

      const uuid = handle.registry.get(SESSION)!.recorder.sessionUuid;
      const outage = gaps(handle.wal.read(uuid));
      expect(outage).toHaveLength(1);
      expect(outage[0]!.body).toMatchObject({
        gap_cause: "daemon_down",
        gap_duration_ms: 3_000,
      });
    });
  });
});
