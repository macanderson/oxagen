import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `run.ts` starts the daemon; these tests drive only its stop path.
vi.mock("./daemon", () => ({ startDaemon: vi.fn() }));

import { writeFileSync } from "node:fs";
import { type HostFile, writeHostFile } from "../host/host-file";
import { agentPaths, type TachoPaths } from "../host/paths";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { TachoHarness } from "../wire";
import type { DaemonHandle, DaemonOptions } from "./daemon";
import {
  daemonAgents,
  STOP_GRACE_MS,
  startAgents,
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
const FLEET_REVOKED = { host_status: "revoked" } as const;

/**
 * Enroll `harnesses` as agent `id` on the machine `home` belongs to, the
 * `day`th of September, and return that agent's paths.
 */
function enrollIn(
  home: TachoPaths,
  id: string,
  harnesses: TachoHarness[],
  day: number,
  overrides: Partial<HostFile> = {},
): TachoPaths {
  const paths = agentPaths(home, id);
  const signer = bundleSigner();
  writeHostFile(
    paths.hostFile,
    testHostFile(signer, signer.sign(unsignedBundle()), {
      host_enrollment_id: `tch_${id}`,
      harnesses,
      port: 47000 + day * 10,
      enrolled_at: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`,
      ...overrides,
    }),
  );
  return paths;
}

/** Each served agent's directory and whether it watches transcripts. */
function served(home: TachoPaths) {
  return daemonAgents(home).map((agent) => [
    agent.paths.dir,
    agent.watchesTranscripts,
  ]);
}

describe("daemonAgents (ADR-203)", () => {
  it("serves no agent on a machine that holds none", () => {
    expect(daemonAgents(scratchPaths())).toEqual([]);
  });

  it("runs a lone agent whether it is live or retired, and it watches transcripts", () => {
    const home = scratchPaths();
    const codex = enrollIn(home, "c0dec000", ["codex"], 10);
    expect(served(home)).toEqual([[codex.dir, true]]);

    // A lone retired agent still runs: its revoke may still be pending.
    const retired = scratchPaths();
    const claude = enrollIn(retired, "c1a0de00", ["claude-code"], 10, RETIRED);
    expect(served(retired)).toEqual([[claude.dir, true]]);
    expect(daemonAgents(retired)[0]?.id).toBe("c1a0de00");
  });

  it("runs every live agent, and the one that hooks Claude Code watches transcripts", () => {
    const home = scratchPaths();
    const codex = enrollIn(home, "c0dec000", ["codex"], 10);
    const claude = enrollIn(home, "c1a0de00", ["claude-code"], 11);
    expect(served(home)).toEqual([
      [codex.dir, false],
      [claude.dir, true],
    ]);

    // With no agent hooking Claude Code, the first one watches.
    const other = scratchPaths();
    const first = enrollIn(other, "c0dec000", ["codex"], 10);
    const cursor = enrollIn(other, "c0c0c0c0", ["cursor"], 11);
    expect(served(other)).toEqual([
      [first.dir, true],
      [cursor.dir, false],
    ]);
  });

  it("drops a retired agent beside a live one, and keeps a fleet-revoked one", () => {
    const home = scratchPaths();
    enrollIn(home, "c1a0de00", ["claude-code"], 10, RETIRED);
    const codex = enrollIn(home, "c0dec000", ["codex"], 11);
    expect(served(home)).toEqual([[codex.dir, true]]);

    // The fleet revoked this one, but the machine did not retire it, so it
    // keeps its collector and its transcript watch.
    const fleet = scratchPaths();
    const revoked = enrollIn(
      fleet,
      "c1a0de00",
      ["claude-code"],
      10,
      FLEET_REVOKED,
    );
    const cursor = enrollIn(fleet, "c0c0c0c0", ["cursor"], 11);
    expect(served(fleet)).toEqual([
      [revoked.dir, true],
      [cursor.dir, false],
    ]);
  });

  it("serves an agent whose host.json it cannot read, so the collector reports it", () => {
    const home = scratchPaths();
    const claude = enrollIn(home, "c1a0de00", ["claude-code"], 10);
    const broken = agentPaths(home, "b0b0b0b0");
    enrollIn(home, "b0b0b0b0", ["codex"], 11);
    writeFileSync(broken.hostFile, "{ not json");
    expect(served(home)).toEqual([
      [claude.dir, true],
      [broken.dir, false],
    ]);
  });
});

describe("startAgents", () => {
  function fakeHandle(): DaemonHandle {
    return { stop: vi.fn(async () => undefined) } as unknown as DaemonHandle;
  }

  /** A Claude Code agent and a Codex agent on one machine. */
  function twoAgents(): { home: TachoPaths; claude: TachoPaths } {
    const home = scratchPaths();
    const claude = enrollIn(home, "c1a0de00", ["claude-code"], 10);
    enrollIn(home, "c0dec000", ["codex"], 11);
    return { home, claude };
  }

  it("starts one collector for a lone agent, on the shared log", async () => {
    const home = scratchPaths();
    const codex = enrollIn(home, "c0dec000", ["codex"], 10);
    const options: DaemonOptions[] = [];
    const started: DaemonHandle[] = [];
    await startAgents(daemonAgents(home), started, vi.fn(), async (o) => {
      options.push(o);
      return fakeHandle();
    });
    expect(started).toHaveLength(1);
    expect(options).toEqual([{ paths: codex }]);
  });

  it("starts a collector per agent, and only the watcher tails transcripts", async () => {
    const { home, claude } = twoAgents();
    const codex = agentPaths(home, "c0dec000");
    const options: DaemonOptions[] = [];
    const started: DaemonHandle[] = [];
    await startAgents(daemonAgents(home), started, vi.fn(), async (o) => {
      options.push(o);
      return fakeHandle();
    });
    expect(started).toHaveLength(2);
    expect(options[0]).toMatchObject({ paths: claude });
    expect(options[0]).not.toHaveProperty("transcriptRoots");
    expect(options[1]).toMatchObject({ paths: codex, transcriptRoots: [] });
    // Each collector's lines name its agent in the shared log.
    expect(options[0]?.log).toBeTypeOf("function");
    expect(options[1]?.log).toBeTypeOf("function");
  });

  it("starts the rest when one agent's collector fails", async () => {
    const { home, claude } = twoAgents();
    const log = vi.fn();
    const started: DaemonHandle[] = [];
    await startAgents(daemonAgents(home), started, log, async (o) => {
      if (o.paths.dir !== claude.dir) throw new Error("host.json is corrupt");
      return fakeHandle();
    });
    expect(started).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "tachod: agent c0dec000 did not start: host.json is corrupt\n",
    );
  });

  it("throws the first failure when no collector started", async () => {
    const { home } = twoAgents();
    const log = vi.fn();
    let calls = 0;
    await expect(
      startAgents(daemonAgents(home), [], log, async () => {
        calls += 1;
        throw new Error(`failure ${calls}`);
      }),
    ).rejects.toThrow("failure 1");
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      "tachod: agent c1a0de00 did not start: failure 1\n",
    );
    await expect(startAgents([], [], log, vi.fn())).rejects.toThrow(
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
