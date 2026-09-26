/**
 * A journaled session end flushed with a long body file that has no index.
 *
 * `appendRecovered` asks the session's body file which of the terminal's
 * bodies it already stores, so a retried batch writes none twice (ADR-139).
 * With no sidecar beside the file, the answer came from reading the whole
 * file on the event loop: 2.2 seconds for a 2.7 GB file, while the daemon
 * answered no hook, no `/status`, and no model call (#4299). The daemon now
 * builds that index with awaited reads before the flush.
 *
 * The test counts the bytes read from body files on the synchronous path,
 * as `wal-index.test.ts` does, rather than timing anything.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import { SessionRecorder } from "../claude-code/recorder";
import { writeSensitiveFileAtomic } from "../host/fs";
import { readHostFile, writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { Wal } from "../host/wal";
import { type DaemonHandle, startDaemon } from "./daemon";
import { parseRegistryState } from "./registry";

/** Bytes read from any body file on the synchronous path. */
const syncReads = vi.hoisted(() => ({ fds: new Set<number>(), bytes: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: ((path, ...rest) => {
      const fd = fs.openSync(path, ...rest);
      if (String(path).endsWith(".bodies.jsonl")) syncReads.fds.add(fd);
      return fd;
    }) as typeof fs.openSync,
    closeSync: ((fd) => {
      syncReads.fds.delete(fd);
      fs.closeSync(fd);
    }) as typeof fs.closeSync,
    readSync: ((fd, ...rest) => {
      const size = (fs.readSync as (...args: unknown[]) => number)(fd, ...rest);
      if (syncReads.fds.has(fd)) syncReads.bytes += size;
      return size;
    }) as typeof fs.readSync,
  };
});

const SESSION = "11111111-2222-3333-4444-555555555555";
const STORED_BODIES = 20_000;

function hook(name: string) {
  return {
    payload: { session_id: SESSION, hook_event_name: name, cwd: "/repo" },
    env: {},
  };
}

describe("a journaled session end over a long body file", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(
    paths: ReturnType<typeof scratchPaths>,
    now: () => number,
  ): Promise<DaemonHandle> {
    const signer = bundleSigner();
    const bundle = signer.sign(
      unsignedBundle({
        retention: { mode: "content_exact", classes: ["model_call"] },
      }),
    );
    const host = readHostFile(paths.hostFile) ?? testHostFile(signer, bundle);
    writeHostFile(paths.hostFile, host);
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
        sweepMs: 60 * 60_000,
        checkpointMs: 60 * 60_000,
        commandsPollMs: 0,
      },
    });
    handles.push(handle);
    return handle;
  }

  it("builds the body index off the synchronous path before it flushes", async () => {
    const paths = scratchPaths();
    const first = await boot(paths, () => 1_000);
    await first.api.handleHook(hook("SessionStart"));
    await first.api.handleHook(hook("Stop"));
    const uuid = first.registry.get(SESSION)!.recorder.sessionUuid;
    const onDisk = first.wal.read(uuid);
    await first.stop();
    handles.splice(0);

    // A session recorded before the index existed: 20,000 stored bodies and
    // no sidecar. Each body names seq 0, so none is past the session's last
    // event and the startup orphan repair keeps them all.
    const bodyPath = join(paths.wal, `${uuid}.bodies.jsonl`);
    const filler = Buffer.from("x".repeat(768)).toString("base64");
    const lines: string[] = [];
    for (let index = 0; index < STORED_BODIES; index += 1)
      lines.push(
        JSON.stringify({
          event_id_idem: `evt_${index.toString(16).padStart(64, "0")}`,
          seq: 0,
          content_type: "text/plain; charset=utf-8",
          bytes_base64: filler,
        }),
      );
    appendFileSync(bodyPath, `\n${lines.join("\n")}\n`);
    rmSync(join(paths.wal, `${uuid}.bodies.index`), { force: true });
    // Everything on disk has shipped, so the shipper builds no index for
    // this session before the flush does.
    new Wal(paths.wal).markShipped(uuid, onDisk.at(-1)!.seq);

    // The session end the daemon journaled before it stopped, with the body
    // of its last frame.
    const persisted = parseRegistryState(
      JSON.parse(readFileSync(paths.daemonState, "utf8")),
    )!;
    const saved = persisted.sessions.find(
      (session) => session.harnessSessionId === SESSION,
    )!;
    const recorder = new SessionRecorder({
      context: {
        agent: onDisk[0]!.agent as ClaudeCodeContext["agent"],
        now: () => 1_000,
      },
      harnessSessionId: SESSION,
      scope: TEST_ENROLLMENT,
      restore: saved.recorder,
    });
    const stop = recorder.sealCollectorEvent("agent_stop", {
      session_outcome: "completed",
    });
    expect(stop.seq).toBe(onDisk.length);
    writeSensitiveFileAtomic(
      paths.pendingEnds,
      JSON.stringify([
        [
          uuid,
          {
            payload: {
              session_id: SESSION,
              hook_event_name: "SessionEnd",
              cwd: "/repo",
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
                // The state the SessionEnd left: the chain is closed.
                sessions: [
                  { ...saved, sealed: true, recorder: recorder.state() },
                ],
                agents: [],
              },
              bodies: [
                {
                  event_id_idem: stop.event_id_idem,
                  session_uuid: uuid,
                  seq: stop.seq,
                  content_type: "text/plain; charset=utf-8",
                  content_class: "model_call",
                  bytes_base64:
                    Buffer.from("the last reply").toString("base64"),
                },
              ],
            },
          },
        ],
      ]),
    );

    const second = await boot(paths, () => 2_000);
    // Startup reads the tail of each body file to cut crash orphans. That
    // read is bounded by one line and is not what this counts.
    syncReads.bytes = 0;
    for (let tick = 0; tick < 3; tick += 1) await second.tick();

    expect(second.registry.get(SESSION)?.sealed).toBe(true);
    expect(second.wal.read(uuid).at(-1)).toEqual(stop);
    expect(
      second.wal
        .bodiesFor([stop])
        .map((body) =>
          Buffer.from(body.bytes_base64, "base64").toString("utf8"),
        ),
    ).toEqual(["the last reply"]);
    expect(existsSync(join(paths.wal, `${uuid}.bodies.index`))).toBe(true);
    // Reading the body file end to end costs every byte of it. A flush over
    // a built index reads nothing on the synchronous path beyond the batch.
    expect(syncReads.bytes).toBeLessThan(statSync(bodyPath).size / 100);
  }, 60_000);
});
