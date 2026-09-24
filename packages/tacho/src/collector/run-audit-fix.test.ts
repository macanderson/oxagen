/**
 * The daemon process after the tachod service audit: a stray rejection is
 * logged and the process keeps serving, an uncaught exception gets a
 * bounded clean stop and exit 1 for the supervisor to restart it, and
 * `tachod.pid` records the executable and is removed as the daemon exits.
 */
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDaemonPid } from "../host/process-scan";

const daemon = vi.hoisted(() => ({
  stop: vi.fn(async () => undefined),
  refreshBundle: vi.fn(async () => true),
}));
vi.mock("./daemon", () => ({ startDaemon: vi.fn(async () => daemon) }));

import {
  guardDaemonProcess,
  releaseDaemonPid,
  runDaemonProcess,
  writeDaemonPid,
} from "./run";

const homes: string[] = [];
const scratch = () => {
  const home = mkdtempSync(join(tmpdir(), "tachod-run-"));
  homes.push(home);
  return home;
};
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function guarded(stop: () => Promise<void>, stopTimeoutMs = 1000) {
  const target = new EventEmitter();
  const log: string[] = [];
  const exits: number[] = [];
  const dispose = guardDaemonProcess({
    stop,
    exit: (code) => exits.push(code),
    log: (line) => log.push(line),
    stopTimeoutMs,
    target,
  });
  return { target, log, exits, dispose };
}

describe("the daemon's last-resort handlers", () => {
  it("logs an unhandled rejection and keeps the process serving", async () => {
    const stop = vi.fn(async () => undefined);
    const { target, log, exits } = guarded(stop);
    target.emit("unhandledRejection", new TypeError("Invalid URL"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(log[0]).toContain(
      "tachod: unhandled rejection: TypeError: Invalid URL",
    );
    expect(stop).not.toHaveBeenCalled();
    expect(exits).toEqual([]);
  });

  it("stops the daemon once and exits 1 on an uncaught exception", async () => {
    const stop = vi.fn(async () => undefined);
    const { target, log, exits } = guarded(stop);
    target.emit("uncaughtException", new Error("boom"));
    target.emit("uncaughtException", new Error("again"));
    await vi.waitFor(() => expect(exits).toEqual([1]));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(log[0]).toContain("tachod: uncaught exception: Error: boom");
    expect(log[1]).toContain("again");
  });

  it("exits 1 when the stop hangs past its bound or fails", async () => {
    const hung = guarded(() => new Promise<void>(() => undefined), 20);
    hung.target.emit("uncaughtException", new Error("boom"));
    await vi.waitFor(() => expect(hung.exits).toEqual([1]));

    const failing = guarded(async () => {
      throw new Error("disk full");
    });
    failing.target.emit("uncaughtException", new Error("boom"));
    await vi.waitFor(() => expect(failing.exits).toEqual([1]));
    expect(failing.log.join("")).toContain("tachod: stop failed: disk full");
  });

  it("removes its handlers when disposed", () => {
    const { target, dispose } = guarded(async () => undefined);
    expect(target.listenerCount("uncaughtException")).toBe(1);
    dispose();
    expect(target.listenerCount("uncaughtException")).toBe(0);
    expect(target.listenerCount("unhandledRejection")).toBe(0);
  });
});

describe("tachod.pid", () => {
  it("records the pid, the start and the executable, and is removed only by its own process", () => {
    const path = join(scratch(), "tachod.pid");
    writeDaemonPid(
      path,
      new Date("2026-09-23T10:00:00.000Z"),
      "C:\\Program Files\\nodejs\\node.exe",
    );
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      pid: process.pid,
      started_at: "2026-09-23T10:00:00.000Z",
      exe: "C:\\Program Files\\nodejs\\node.exe",
    });
    releaseDaemonPid(path);
    expect(existsSync(path)).toBe(false);
    releaseDaemonPid(path);
    writeFileSync(path, "999999\n");
    releaseDaemonPid(path);
    expect(existsSync(path)).toBe(true);
  });

  it("is written at start and removed when SIGTERM stops the daemon", async () => {
    const home = scratch();
    const events = [
      "SIGTERM",
      "SIGINT",
      "SIGHUP",
      "uncaughtException",
      "unhandledRejection",
    ] as const;
    const before = new Map<string, unknown[]>(
      events.map((event) => [event, process.listeners(event)]),
    );
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const previous = process.env["TACHO_HOME"];
    process.env["TACHO_HOME"] = home;
    try {
      void runDaemonProcess();
      const pidPath = join(home, "tachod.pid");
      await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true));
      expect(parseDaemonPid(readFileSync(pidPath, "utf8"))).toMatchObject({
        pid: process.pid,
        exe: process.execPath,
      });
      // The last-resort handlers are on the process for `tachod` and for
      // `tacho daemon` alike: both run this body.
      for (const event of ["uncaughtException", "unhandledRejection"] as const)
        expect(process.listenerCount(event)).toBe(
          (before.get(event)?.length ?? 0) + 1,
        );
      const sigterm = process
        .listeners("SIGTERM")
        .find((listener) => !before.get("SIGTERM")?.includes(listener));
      (sigterm as () => void)();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(daemon.stop).toHaveBeenCalledTimes(1);
      expect(existsSync(pidPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["TACHO_HOME"];
      else process.env["TACHO_HOME"] = previous;
      for (const event of events)
        for (const listener of process.listeners(event))
          if (!before.get(event)?.includes(listener))
            process.off(event, listener as (...args: unknown[]) => void);
      exit.mockRestore();
    }
  });
});
