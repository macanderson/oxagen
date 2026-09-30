/**
 * A first start on a machine with a long Claude Code history (#4394).
 *
 * The tick tails the transcript of every session the registry holds, and on a
 * new install that is hundreds of files the daemon has never read. The tick
 * used to read them inside the one hook queue, so every hook on the host
 * waited for the whole backfill. One host logged 305 hooks on 2026-09-26: 27
 * took over three seconds and the slowest took 10,404 ms.
 *
 * Here the registry holds three hundred unread transcripts, and one tick reads
 * as many of them as its 16 MiB budget takes while another session's hooks
 * are answered. No hook waits a second. Each open of a transcript is held a
 * few milliseconds, so the tick runs past a second on any machine and a hook
 * held behind it would show.
 */
import { copyFileSync, promises as fsp, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type DaemonHandle, startDaemon } from "./daemon";

const FIXTURE = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "claude-code",
  "transcript",
  "session.jsonl",
);
const TRANSCRIPTS = 300;
/** How long each open of a backfilled transcript is held. */
const OPEN_DELAY_MS = 4;
const LIVE = "11111111-2222-4333-8444-555555555555";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("a backfill of old transcripts", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const handle of handles.splice(0)) await handle.stop();
  });

  it("answers every hook within a second while a tick backfills old transcripts", async () => {
    const paths = scratchPaths();
    const signer = bundleSigner();
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    const handle = await startDaemon({
      paths,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      exec: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      log: () => undefined,
      listen: false,
      transcriptRoots: [`${paths.tachoDir}/no-transcripts`],
      timers: {
        detectorMs: 60 * 60_000,
        sweepMs: 60 * 60_000,
        checkpointMs: 60 * 60_000,
      },
    });
    handles.push(handle);

    // Sessions the daemon holds and has never read a byte of, the way a new
    // install finds the history under `~/.claude/projects`.
    const dir = join(paths.tachoDir, "history");
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < TRANSCRIPTS; index += 1) {
      const id = `backfill-${String(index).padStart(4, "0")}`;
      const path = join(dir, `${id}.jsonl`);
      copyFileSync(FIXTURE, path);
      handle.registry.ensure(id, { transcriptPath: path, ambient: true });
    }
    await handle.api.handleHook({
      payload: {
        session_id: LIVE,
        hook_event_name: "SessionStart",
        cwd: "/repo",
      },
      env: {},
    });

    const open = fsp.open.bind(fsp) as (...args: unknown[]) => Promise<unknown>;
    let reading = false;
    vi.spyOn(fsp, "open").mockImplementation((async (...args: unknown[]) => {
      if (String(args[0]).startsWith(dir)) {
        reading = true;
        await sleep(OPEN_DELAY_MS);
      }
      return open(...args);
    }) as unknown as typeof fsp.open);

    let ticked = false;
    const ticking = handle.tick().finally(() => {
      ticked = true;
    });
    while (!reading && !ticked) await sleep(1);
    expect(reading).toBe(true);
    const waits: number[] = [];
    while (!ticked) {
      const started = Date.now();
      await handle.api.handleHook({
        payload: {
          session_id: LIVE,
          hook_event_name: "PreToolUse",
          cwd: "/repo",
          tool_name: "Read",
          tool_input: { file_path: "README.md" },
          tool_use_id: `toolu_${waits.length}`,
        },
        env: {},
      });
      waits.push(Date.now() - started);
      await sleep(10);
    }
    await ticking;

    // The hooks ran beside the backfill, not after it.
    expect(waits.length).toBeGreaterThan(3);
    expect(Math.max(...waits)).toBeLessThan(1_000);
    // And the backfill ran: the first transcript's model calls are sealed.
    const first = handle.registry.get("backfill-0000")?.recorder.sessionUuid;
    expect(
      handle.wal.read(first ?? "").some((event) => event.kind === "llm_call"),
    ).toBe(true);
  }, 60_000);
});
