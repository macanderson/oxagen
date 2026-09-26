/**
 * Ended sessions the host can close itself, rather than leave to the
 * six-hour idle sweep or the control plane's twelve-hour close (#3989).
 *
 * Each hook here goes through `runTachoHook`, the code `tacho hook` runs,
 * and reaches the daemon the way a real one does: forwarded to its hook
 * route while it is up, or spooled while it is down.
 */
import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import { runTachoHook, type UnixPostOptions } from "../claude-code/hook-client";
import { readHostFile, writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { toProtocolTimestamp } from "../timestamp";
import { type DaemonHandle, startDaemon } from "./daemon";
import type { HookEnvelope } from "./server";

const CODEX = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";
const CLAUDE = "11111111-2222-3333-4444-555555555555";
const CURSOR = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
/** A pid no process holds. */
const DEAD_PID = 2147483647;

type Paths = ReturnType<typeof scratchPaths>;

describe("a session the host closes when its harness ends", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  let clock = Date.parse("2026-09-25T10:00:00.000Z");
  const now = () => clock;

  async function boot(paths: Paths): Promise<DaemonHandle> {
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
      now,
      log: () => undefined,
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
    return handle;
  }

  /** A `post` that hands the hook to this daemon's hook route. */
  function forwardTo(handle: DaemonHandle) {
    return async (options: UnixPostOptions) => {
      const envelope = JSON.parse(options.body) as HookEnvelope;
      const answer = await handle.api.handleHook(envelope);
      return { status: 200, body: JSON.stringify(answer) };
    };
  }

  function lastKind(handle: DaemonHandle, sessionId: string): string {
    const uuid = handle.registry.get(sessionId)!.recorder.sessionUuid;
    return handle.wal.read(uuid).at(-1)?.kind ?? "";
  }

  it("seals a Codex session within one sweep of the Codex process exiting", async () => {
    const paths = scratchPaths();
    const handle = await boot(paths);
    const start = (session: string, pid: number) =>
      runTachoHook({
        paths,
        env: {},
        stdin: JSON.stringify({
          session_id: session,
          hook_event_name: "SessionStart",
          source: "startup",
          cwd: "/repo",
        }),
        harness: "codex",
        harnessPid: () => pid,
        platform: "linux",
        now,
        post: forwardTo(handle),
      });
    expect((await start(CODEX, DEAD_PID)).path).toBe("daemon");
    const live = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5c";
    expect((await start(live, process.pid)).path).toBe("daemon");

    clock += 60_000;
    await handle.tick();

    const ended = handle.registry.get(CODEX)!;
    expect(ended.harness).toBe("codex");
    expect(ended.sealed).toBe(true);
    expect(lastKind(handle, CODEX)).toBe("agent_stop");
    expect(
      verifyChain(handle.wal.read(ended.recorder.sessionUuid), {
        expectGenesis: true,
      }),
    ).toMatchObject({ ok: true });
    // The Codex process that is still running keeps its session open.
    expect(handle.registry.get(live)!.sealed).toBe(false);
  });

  it("leaves a Cursor session to its own sessionEnd and the idle bound", async () => {
    const paths = scratchPaths();
    const handle = await boot(paths);
    const result = await runTachoHook({
      paths,
      env: {},
      stdin: JSON.stringify({
        conversation_id: CURSOR,
        session_id: CURSOR,
        hook_event_name: "sessionStart",
        workspace_roots: ["/repo"],
      }),
      harness: "cursor",
      harnessPid: () => DEAD_PID,
      platform: "linux",
      now,
      post: forwardTo(handle),
    });
    expect(result.path).toBe("daemon");
    clock += 60_000;
    await handle.tick();
    const record = handle.registry.get(CURSOR)!;
    expect(record.pid).toBeUndefined();
    expect(record.sealed).toBe(false);
  });

  it("seals a Claude Code session from a SessionEnd spooled while the daemon was down", async () => {
    const paths = scratchPaths();
    const handle = await boot(paths);
    await handle.api.handleHook({
      payload: {
        session_id: CLAUDE,
        hook_event_name: "SessionStart",
        source: "startup",
        cwd: "/repo",
      },
      env: { CLAUDE_PID: String(process.pid) },
    });

    // The daemon does not answer, so `tacho hook` spools the event.
    clock += 5_000;
    const endedAt = clock;
    const ended = await runTachoHook({
      paths,
      env: {},
      stdin: JSON.stringify({
        session_id: CLAUDE,
        hook_event_name: "SessionEnd",
        reason: "prompt_input_exit",
        cwd: "/repo",
      }),
      now,
      post: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(ended.path).toBe("local");
    expect(ended.stdout).toBe("{}\n");
    expect(
      readdirSync(paths.spool).filter((f) => f.endsWith(".json")),
    ).toHaveLength(1);
    expect(handle.registry.get(CLAUDE)!.sealed).toBe(false);

    // The daemon replays the spool on its next tick, and the session ends
    // when Claude Code said it did, not when the replay ran.
    clock += 60 * 60_000;
    await handle.tick();
    const record = handle.registry.get(CLAUDE)!;
    expect(record.sealed).toBe(true);
    const chain = handle.wal.read(record.recorder.sessionUuid);
    const stop = chain.at(-1);
    expect(stop?.kind).toBe("agent_stop");
    expect(stop?.ts).toBe(toProtocolTimestamp(endedAt));
    expect(verifyChain(chain, { expectGenesis: true })).toMatchObject({
      ok: true,
    });
    expect(readdirSync(paths.spool).filter((f) => f.endsWith(".json"))).toEqual(
      [],
    );
  });
});
