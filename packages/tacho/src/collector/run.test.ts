import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `run.ts` starts the daemon; these tests drive only its stop path.
vi.mock("./daemon", () => ({ startDaemon: vi.fn() }));

import { type HostFile, writeHostFile } from "../host/host-file";
import type { TachoPaths } from "../host/paths";
import { slotPaths } from "../host/slots";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { TachoHarness } from "../wire";
import type { DaemonHandle, DaemonOptions } from "./daemon";
import {
  daemonSlots,
  STOP_GRACE_MS,
  startSlots,
  stopAll,
  stopWithin,
} from "./run";

describe("stopWithin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // #4012: `stop()` waits on the git lane, so a SIGTERM during a re-enroll
  // kept the old daemon alive past launchctl's bootstrap retries, and launchd
  // then removed the service the new bootstrap had loaded.
  it("exits 1 when stop has not finished within the grace period", () => {
    const exit = vi.fn();
    const log = vi.fn();
    stopWithin(() => new Promise<void>(() => undefined), 5_000, exit, log);
    vi.advanceTimersByTime(4_999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("5000 ms"));
  });

  it("exits 0 when stop finishes in time, and the timer does not fire later", async () => {
    const exit = vi.fn();
    stopWithin(() => Promise.resolve(), 5_000, exit, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(0);
    vi.advanceTimersByTime(10_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits 1 and logs the reason when stop fails", async () => {
    const exit = vi.fn();
    const log = vi.fn();
    stopWithin(() => Promise.reject(new Error("disk full")), 5_000, exit, log);
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    vi.advanceTimersByTime(10_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("keeps the grace period inside the service managers' 10 s kill timeouts", () => {
    expect(STOP_GRACE_MS).toBeLessThan(10_000);
  });
});

const RETIRED = { revoked_at: "2026-09-20T00:00:00.000Z" };

/**
 * Enroll `harnesses` in `slot`'s directory, or at the root when `slot` is
 * undefined, and return that slot's paths.
 */
function enrollIn(
  root: TachoPaths,
  slot: TachoHarness | undefined,
  harnesses: TachoHarness[],
  overrides: Partial<HostFile> = {},
): TachoPaths {
  const paths = slot === undefined ? root : slotPaths(root, slot);
  const signer = bundleSigner();
  writeHostFile(
    paths.hostFile,
    testHostFile(signer, signer.sign(unsignedBundle()), {
      host_enrollment_id: `tch_${slot ?? "root"}`,
      harnesses,
      ...overrides,
    }),
  );
  return paths;
}

/** The slot's directory, harness and whether it watches transcripts. */
function served(root: TachoPaths) {
  return daemonSlots(root).map((slot) => [
    slot.paths.root,
    slot.harness,
    slot.watchesTranscripts,
  ]);
}

describe("daemonSlots (ADR-202)", () => {
  it("runs the root alone, enrolled, retired or empty, and it watches transcripts", () => {
    const empty = scratchPaths();
    expect(served(empty)).toEqual([[empty.root, undefined, true]]);

    const retired = scratchPaths();
    enrollIn(retired, undefined, ["claude-code"], RETIRED);
    expect(served(retired)).toEqual([[retired.root, undefined, true]]);
  });

  it("runs every live agent, and the one that hooks Claude Code watches transcripts", () => {
    const root = scratchPaths();
    enrollIn(root, undefined, ["claude-code"]);
    const codex = enrollIn(root, "codex", ["codex"]);
    expect(served(root)).toEqual([
      [root.root, undefined, true],
      [codex.root, "codex", false],
    ]);

    // Claude Code enrolled second, beside a root that hooks Codex.
    const other = scratchPaths();
    enrollIn(other, undefined, ["codex"]);
    const claude = enrollIn(other, "claude-code", ["claude-code"]);
    expect(served(other)).toEqual([
      [other.root, undefined, false],
      [claude.root, "claude-code", true],
    ]);
  });

  it("drops a retired agent beside a live one, and a root with no host.json", () => {
    const root = scratchPaths();
    enrollIn(root, undefined, ["claude-code"]);
    enrollIn(root, "codex", ["codex"], RETIRED);
    expect(served(root)).toEqual([[root.root, undefined, true]]);

    const retiredRoot = scratchPaths();
    enrollIn(retiredRoot, undefined, ["claude-code"], RETIRED);
    const codex = enrollIn(retiredRoot, "codex", ["codex"]);
    expect(served(retiredRoot)).toEqual([[codex.root, "codex", false]]);

    const bareRoot = scratchPaths();
    const cursor = enrollIn(bareRoot, "cursor", ["cursor"]);
    expect(served(bareRoot)).toEqual([[cursor.root, "cursor", false]]);
  });
});

describe("startSlots", () => {
  function fakeHandle(): DaemonHandle {
    return { stop: vi.fn(async () => undefined) } as unknown as DaemonHandle;
  }

  it("starts a collector per slot, and only the watcher tails transcripts", async () => {
    const root = scratchPaths();
    enrollIn(root, undefined, ["claude-code"]);
    const codex = enrollIn(root, "codex", ["codex"]);
    const options: DaemonOptions[] = [];
    const started: DaemonHandle[] = [];
    await startSlots(daemonSlots(root), started, vi.fn(), async (o) => {
      options.push(o);
      return fakeHandle();
    });
    expect(started).toHaveLength(2);
    expect(options[0]).toEqual({ paths: root });
    expect(options[1]).toMatchObject({ paths: codex, transcriptRoots: [] });
    // The Codex collector's lines name its harness in the shared log.
    expect(options[1]?.log).toBeTypeOf("function");
  });

  it("starts the rest when one agent's collector fails", async () => {
    const root = scratchPaths();
    enrollIn(root, undefined, ["claude-code"]);
    enrollIn(root, "codex", ["codex"]);
    const log = vi.fn();
    const started: DaemonHandle[] = [];
    await startSlots(daemonSlots(root), started, log, async (o) => {
      if (o.paths.root !== root.root) throw new Error("host.json is corrupt");
      return fakeHandle();
    });
    expect(started).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "tachod: the codex enrollment did not start: host.json is corrupt\n",
    );
  });

  it("throws the first failure when no collector started", async () => {
    const root = scratchPaths();
    enrollIn(root, undefined, ["claude-code"]);
    enrollIn(root, "codex", ["codex"]);
    const log = vi.fn();
    let calls = 0;
    await expect(
      startSlots(daemonSlots(root), [], log, async () => {
        calls += 1;
        throw new Error(`failure ${calls}`);
      }),
    ).rejects.toThrow("failure 1");
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      "tachod: the first enrollment did not start: failure 1\n",
    );
    await expect(startSlots([], [], log, vi.fn())).rejects.toThrow(
      "no enrollment on this machine",
    );
  });
});

describe("stopAll", () => {
  it("stops every collector, and fails when one stop failed", async () => {
    const stopped = { stop: vi.fn(async () => undefined) };
    const broken = {
      stop: vi.fn(async () => {
        throw new Error("wal is locked");
      }),
    };
    const later = { stop: vi.fn(async () => undefined) };
    await expect(
      stopAll([stopped, broken, later] as unknown as DaemonHandle[]),
    ).rejects.toThrow("wal is locked");
    expect(stopped.stop).toHaveBeenCalledTimes(1);
    expect(later.stop).toHaveBeenCalledTimes(1);
    await expect(
      stopAll([stopped] as unknown as DaemonHandle[]),
    ).resolves.toBeUndefined();
  });
});
