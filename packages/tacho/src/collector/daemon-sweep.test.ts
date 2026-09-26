/**
 * The sweep writes and seals each idle session on its own (#3719).
 *
 * It used to seal every idle session's final events, mark each one sealed,
 * and then write them all in one call. When that write failed, the cursors
 * went back but the sealed flags stayed: no `agent_stop` reached the WAL, no
 * later sweep looked at those sessions again, and `forgetSealed` dropped
 * them. One session whose write failed also took every other session in the
 * same sweep down with it.
 */
import { readFileSync, statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import { readHostFile, writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type DaemonHandle, startDaemon } from "./daemon";
import { SEALED_STATE_RETAIN_MS } from "./registry";

const FIRST = "11111111-2222-3333-4444-555555555555";
const SECOND = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const IDLE_MS = 60_000;

function hook(session: string, name: string) {
  return {
    payload: { session_id: session, hook_event_name: name, cwd: "/repo" },
    env: {},
  };
}

describe("the sweep", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(
    now: () => number,
    paths = scratchPaths(),
  ): Promise<DaemonHandle> {
    const signer = bundleSigner();
    const bundle = signer.sign(unsignedBundle());
    const host = readHostFile(paths.hostFile) ?? testHostFile(signer, bundle);
    writeHostFile(paths.hostFile, host);
    const handle = await startDaemon({
      paths,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      exec: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      now,
      log: () => {},
      listen: false,
      transcriptRoots: [`${paths.root}/no-transcripts`],
      timers: {
        detectorMs: 60 * 60_000,
        sweepMs: 0,
        checkpointMs: 60 * 60_000,
        commandsPollMs: 0,
        idleSessionMs: IDLE_MS,
      },
    });
    handles.push(handle);
    return handle;
  }

  it("seals one idle session when another's final write fails, and closes the other on the next sweep", async () => {
    let clock = 1_000;
    const handle = await boot(() => clock);
    await handle.api.handleHook(hook(FIRST, "SessionStart"));
    await handle.api.handleHook(hook(SECOND, "SessionStart"));
    const first = handle.registry.get(FIRST)!;
    const second = handle.registry.get(SECOND)!;
    const firstUuid = first.recorder.sessionUuid;
    const secondUuid = second.recorder.sessionUuid;
    const firstCursor = { ...first.recorder.chainCursor };

    // The disk refuses every write that carries the first session's events.
    const append = handle.wal.append.bind(handle.wal);
    handle.wal.append = (events, bodies) => {
      if (events.some((event) => event.session_uuid === firstUuid))
        throw new Error("ENOSPC: no space left on device");
      append(events, bodies);
    };

    clock += IDLE_MS * 2;
    await handle.tick();

    // The second session closed, and its `agent_stop` is on disk.
    expect(second.sealed).toBe(true);
    const secondChain = handle.wal.read(secondUuid);
    expect(secondChain.at(-1)?.kind).toBe("agent_stop");
    expect(verifyChain(secondChain, { expectGenesis: true })).toMatchObject({
      ok: true,
    });

    // The first is still open, at the cursor it had before the sweep.
    expect(first.sealed).toBe(false);
    expect(first.recorder.chainCursor).toEqual(firstCursor);
    expect(
      handle.wal.read(firstUuid).some((event) => event.kind === "agent_stop"),
    ).toBe(false);

    // The disk recovers, and the next sweep closes the first session too.
    handle.wal.append = append;
    await handle.tick();
    expect(first.sealed).toBe(true);
    const firstChain = handle.wal.read(firstUuid);
    expect(firstChain.at(-1)?.kind).toBe("agent_stop");
    expect(verifyChain(firstChain, { expectGenesis: true })).toMatchObject({
      ok: true,
    });
  });

  it("drops a sealed session's call ledgers an hour after it went quiet", async () => {
    let clock = 1_000;
    const handle = await boot(() => clock);
    await handle.api.handleHook(hook(FIRST, "SessionStart"));
    await handle.api.handleHook(hook(FIRST, "SessionEnd"));
    const record = handle.registry.get(FIRST)!;
    await handle.tick();
    expect(record.sealed).toBe(true);
    clock += SEALED_STATE_RETAIN_MS + 1_000;
    await handle.tick();
    // The tick's sweep released it, so there is nothing left to release.
    expect(handle.registry.releaseSealedState()).toBe(0);
    expect(record.sealed).toBe(true);
  });

  it("writes released sessions to their own file once, and keeps them out of daemon.json", async () => {
    let clock = 1_000;
    const paths = scratchPaths();
    const handle = await boot(() => clock, paths);
    const ended = Array.from(
      { length: 30 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const LIVE = "99999999-0000-4000-8000-000000000000";
    for (const session of ended) {
      await handle.api.handleHook(hook(session, "SessionStart"));
      await handle.api.handleHook(hook(session, "SessionEnd"));
    }
    // The git lane reads a few worktrees a tick before each SessionEnd seals.
    for (let turn = 0; turn < 10; turn += 1) await handle.tick();
    expect(ended.every((s) => handle.registry.get(s)!.sealed)).toBe(true);
    clock += SEALED_STATE_RETAIN_MS + 1_000;
    await handle.api.handleHook(hook(LIVE, "SessionStart"));
    await handle.tick();
    const uuids = ended.map(
      (session) => handle.registry.get(session)!.recorder.sessionUuid,
    );
    const sealedFile = () => readFileSync(paths.daemonSealedState, "utf8");
    const daemonFile = () => readFileSync(paths.daemonState, "utf8");
    for (const uuid of uuids) expect(sealedFile()).toContain(uuid);

    // Every later tick writes daemon.json with what is running, and leaves
    // the file of released sessions alone.
    const written = statSync(paths.daemonSealedState).ino;
    for (let turn = 0; turn < 3; turn += 1) {
      clock += 1_000;
      await handle.api.handleHook(hook(LIVE, "UserPromptSubmit"));
      await handle.tick();
    }
    expect(statSync(paths.daemonSealedState).ino).toBe(written);
    const hot = JSON.parse(daemonFile()) as { sessions: unknown[] };
    expect(hot.sessions).toHaveLength(2);
    for (const uuid of uuids) expect(daemonFile()).not.toContain(uuid);

    // A restart reads both files back.
    await handle.stop();
    handles.splice(handles.indexOf(handle), 1);
    const again = await boot(() => clock, paths);
    for (const [i, session] of ended.entries()) {
      const record = again.registry.get(session);
      expect(record?.sealed).toBe(true);
      expect(record?.recorder.sessionUuid).toBe(uuids[i]);
    }
    expect(again.registry.get(LIVE)?.sealed).toBe(false);
  });
});
