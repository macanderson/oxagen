/**
 * The hourly compaction stage (audit finding W-08, #3944).
 *
 * The stage set its clock before it compacted, and swept the quarantine
 * after. A pass that threw skipped the sweep and waited an hour to try
 * again.
 */
import { mkdirSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readHostFile, writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type DaemonHandle, startDaemon } from "./daemon";

describe("the compaction stage", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  it("sweeps the quarantine when the pass throws, and tries the pass again a minute later", async () => {
    const paths = scratchPaths();
    const signer = bundleSigner();
    const bundle = signer.sign(unsignedBundle());
    const host = readHostFile(paths.hostFile) ?? testHostFile(signer, bundle);
    writeHostFile(paths.hostFile, host);
    const retainMs = 86_400_000;
    let clock = 10 * retainMs;
    const logs: string[] = [];
    const handle = await startDaemon({
      paths,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      exec: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      now: () => clock,
      log: (line) => logs.push(line),
      listen: false,
      transcriptRoots: [`${paths.root}/no-transcripts`],
      timers: {
        detectorMs: 60 * 60_000,
        sweepMs: 60 * 60_000,
        checkpointMs: 60 * 60_000,
        commandsPollMs: 0,
        walRetainMs: retainMs,
      },
    });
    handles.push(handle);
    // A refused event past the retention window.
    mkdirSync(paths.quarantine, { recursive: true });
    const refused = join(paths.quarantine, "refused.json");
    writeFileSync(refused, "{}");
    utimesSync(refused, 1, 1);
    const compact = vi
      .spyOn(handle.wal, "compact")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("EIO: i/o error, scandir"), {
          code: "EIO",
        });
      });

    await handle.tick();
    expect(compact).toHaveBeenCalledTimes(1);
    expect(logs.some((line) => line.includes("EIO"))).toBe(true);
    expect(existsSync(refused)).toBe(false);

    clock += 2 * 60_000;
    await handle.tick();
    expect(compact).toHaveBeenCalledTimes(2);

    // A pass that succeeds waits the hour.
    clock += 2 * 60_000;
    await handle.tick();
    expect(compact).toHaveBeenCalledTimes(2);
    compact.mockRestore();
  });
});
