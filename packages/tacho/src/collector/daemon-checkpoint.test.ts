/**
 * A checkpoint writes one event per live session in a single WAL call. When
 * the disk refused the second session's file, the first session's checkpoint
 * stayed on disk while the checkpoint rolled every chain back, so the first
 * session's recorder stood one seq behind its WAL tail. Every later
 * checkpoint sealed that seq again, the WAL refused it, and no session on the
 * host got a checkpoint until the daemon restarted (#4311 item 1).
 *
 * The fault is a real `appendFileSync` failure on one file, so the real
 * `Wal.append` runs and decides what stays on disk.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyChain } from "../chain";
import { readHostFile, writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type DaemonHandle, startDaemon } from "./daemon";

/** The one write the disk refuses: a file, and text the write must carry. */
const fault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  carrying: "",
  fired: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    appendFileSync: ((path, data, ...rest) => {
      if (
        fault.path !== undefined &&
        String(path) === fault.path &&
        String(data).includes(fault.carrying)
      ) {
        fault.path = undefined;
        fault.fired += 1;
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
      }
      return (fs.appendFileSync as (...args: unknown[]) => void)(
        path,
        data,
        ...rest,
      );
    }) as typeof fs.appendFileSync,
  };
});

const FIRST = "11111111-2222-3333-4444-555555555555";
const SECOND = "66666666-7777-8888-9999-aaaaaaaaaaaa";

function hook(session: string, name: string) {
  return {
    payload: { session_id: session, hook_event_name: name, cwd: "/repo" },
    env: {},
  };
}

describe("the checkpoint", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    fault.path = undefined;
    for (const handle of handles.splice(0)) await handle.stop();
  });

  it("lands for both sessions on the next tick after the second session's file refused the write", async () => {
    const paths = scratchPaths();
    const signer = bundleSigner();
    const bundle = signer.sign(unsignedBundle());
    const host = readHostFile(paths.hostFile) ?? testHostFile(signer, bundle);
    writeHostFile(paths.hostFile, host);
    const logs: string[] = [];
    const handle = await startDaemon({
      paths,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      exec: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      now: () => 1_000,
      log: (line) => logs.push(line),
      listen: false,
      transcriptRoots: [`${paths.root}/no-transcripts`],
      timers: {
        detectorMs: 60 * 60_000,
        sweepMs: 60 * 60_000,
        checkpointMs: 0,
        commandsPollMs: 0,
      },
    });
    handles.push(handle);
    await handle.api.handleHook(hook(FIRST, "SessionStart"));
    await handle.api.handleHook(hook(SECOND, "SessionStart"));
    // The checkpoint writes the sessions in the registry's order, so the
    // fault goes on whichever file it writes second.
    const [, written] = handle.registry.list();
    const uuids = handle.registry
      .list()
      .map((session) => session.recorder.sessionUuid);
    const cursors = handle.registry
      .list()
      .map((session) => ({ ...session.recorder.chainCursor }));
    const checkpoints = (uuid: string) =>
      handle.wal.read(uuid).filter((event) => event.kind === "checkpoint");
    fault.path = join(paths.wal, `${written!.recorder.sessionUuid}.ndjson`);
    fault.carrying = '"kind":"checkpoint"';

    await handle.tick();

    expect(fault.fired).toBe(1);
    // Neither session's checkpoint is on disk, and each chain is where the
    // checkpoint found it.
    for (const uuid of uuids) expect(checkpoints(uuid)).toHaveLength(0);
    expect(
      handle.registry
        .list()
        .map((session) => ({ ...session.recorder.chainCursor })),
    ).toEqual(cursors);

    await handle.tick();

    for (const uuid of uuids) {
      expect(checkpoints(uuid)).toHaveLength(1);
      expect(verifyChain(handle.wal.read(uuid))).toMatchObject({ ok: true });
    }
  });
});
