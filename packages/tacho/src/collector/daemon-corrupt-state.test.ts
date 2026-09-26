/**
 * A daemon whose state files a short write cut (audit finding W-05, #3944).
 *
 * `writeFileAtomic` ignored the byte count `writeSync` returned, so a disk
 * that filled part way through a write renamed a truncated file into place.
 * At the next start, `cursor.json` or `daemon.json` threw a `SyntaxError`,
 * and the daemon refused to start until someone deleted the file by hand.
 * Each one is now moved aside and the daemon starts without it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

const SESSION = "11111111-2222-3333-4444-555555555555";

function hook(name: string, extra: Record<string, unknown> = {}) {
  return {
    payload: {
      session_id: SESSION,
      hook_event_name: name,
      cwd: "/repo",
      ...extra,
    },
    env: {},
  };
}

describe("a daemon over truncated state files", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(
    paths: ReturnType<typeof scratchPaths>,
    log: string[],
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
      now: () => 1_000,
      log: (line) => log.push(line),
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

  it("moves each one aside, starts, and keeps recording the session", async () => {
    const paths = scratchPaths();
    const first = await boot(paths, []);
    await first.api.handleHook(hook("SessionStart"));
    await first.api.handleHook(hook("Stop"));
    await first.tick();
    const uuid = first.registry.get(SESSION)!.recorder.sessionUuid;
    await first.stop();
    handles.splice(0);

    const cut = [
      join(paths.wal, "cursor.json"),
      paths.daemonState,
      paths.transcriptTailState,
      paths.pendingEnds,
    ];
    for (const path of cut) {
      const text = existsSync(path)
        ? readFileSync(path, "utf8")
        : '{"schema":"tacho.transcript-tail.v1","cursors":{}}';
      writeFileSync(path, text.slice(0, Math.floor(text.length / 2)));
    }

    const log: string[] = [];
    const second = await boot(paths, log);
    expect(
      log.filter((line) => line.includes("did not parse; moved it to")),
    ).toHaveLength(cut.length);
    for (const path of cut) {
      expect(existsSync(path)).toBe(false);
      expect(
        readdirSync(dirname(path)).filter((name) =>
          name.startsWith(`${basename(path)}.corrupt-`),
        ),
      ).toHaveLength(1);
    }

    await second.api.handleHook(hook("UserPromptSubmit", { prompt: "go" }));
    await second.api.handleHook(hook("Stop"));
    await second.tick();
    const chain = second.wal.read(uuid);
    expect(chain.filter((event) => event.kind === "turn_start")).toHaveLength(
      1,
    );
    expect(verifyChain(chain, { expectGenesis: true })).toMatchObject({
      ok: true,
    });
  });
});
