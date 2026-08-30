/**
 * Output-discipline tests for the daemon lifecycle commands (ADR-023 §4):
 * status/stop/start-already-running speak both modes with machine envelopes on
 * stdout; the session verbs preserve their legacy JSON response shapes (now
 * single-line); "daemon down" and RPC failures are uniform stderr errors with
 * exit 1. The DaemonClient is mocked — no socket, no spawn, no server import
 * (foreground start and the detached spawn path are intentionally untested
 * here: they block / fork real processes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandWriter } from "../lib/capture-writer.js";

const client = {
  isRunning: vi.fn(),
  shutdown: vi.fn(),
  send: vi.fn(),
  listSessions: vi.fn(),
  forkSession: vi.fn(),
  replaySession: vi.fn(),
};

vi.mock("./client.js", () => ({
  DaemonClient: vi.fn(() => client),
}));

import {
  daemonStatus,
  sessionFork,
  sessionList,
  sessionReplay,
  startDaemon,
  stopDaemon,
} from "./lifecycle.js";

function memoryWriter(): {
  writer: CommandWriter;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (line) => {
        out.push(line);
      },
      writeErr: (line) => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

const savedExit = process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  process.exitCode = savedExit;
});

describe("daemon status", () => {
  it("not running: machine envelope on stdout / pretty hint, nothing on stderr", async () => {
    client.isRunning.mockResolvedValue(false);
    const { writer, out, err } = memoryWriter();
    await daemonStatus({ json: true }, writer);
    expect(JSON.parse(out[0] as string)).toMatchObject({ running: false });
    expect(err).toEqual([]);

    const pretty = memoryWriter();
    await daemonStatus({}, pretty.writer);
    expect(pretty.out.join("\n")).toContain("Daemon is not running");
  });

  it("running: health envelope with pid + uptime", async () => {
    client.isRunning.mockResolvedValue(true);
    client.send.mockResolvedValue({
      result: { status: "ok", uptime: 3725, pid: 999 },
    });
    const { writer, out } = memoryWriter();
    await daemonStatus({ json: true }, writer);
    expect(JSON.parse(out[0] as string)).toMatchObject({
      running: true,
      pid: 999,
      uptimeSeconds: 3725,
    });

    const pretty = memoryWriter();
    await daemonStatus({}, pretty.writer);
    expect(pretty.out.join("\n")).toContain("1h 2m 5s");
  });

  it("health RPC failure is a uniform error with exit 1", async () => {
    client.isRunning.mockResolvedValue(true);
    client.send.mockRejectedValue(new Error("socket hiccup"));
    const { writer, out, err } = memoryWriter();
    process.exitCode = 0;
    await daemonStatus({ json: true }, writer);
    expect(out).toEqual([]);
    expect(JSON.parse(err[0] as string)).toMatchObject({ type: "error" });
    expect(process.exitCode).toBe(1);
  });
});

describe("daemon start/stop (non-forking paths)", () => {
  it("start when already running reports without spawning", async () => {
    client.isRunning.mockResolvedValue(true);
    const { writer, out } = memoryWriter();
    await startDaemon({ foreground: false, json: true }, writer);
    expect(JSON.parse(out[0] as string)).toMatchObject({
      running: true,
      started: false,
    });
  });

  it("stop when not running is a no-op result, not an error", async () => {
    client.isRunning.mockResolvedValue(false);
    const { writer, out, err } = memoryWriter();
    await stopDaemon({ json: true }, writer);
    expect(JSON.parse(out[0] as string)).toMatchObject({
      running: false,
      stopped: false,
    });
    expect(err).toEqual([]);
  });

  it("stop shuts a running daemon down", async () => {
    client.isRunning.mockResolvedValue(true);
    client.shutdown.mockResolvedValue(undefined);
    const { writer, out } = memoryWriter();
    await stopDaemon({}, writer);
    expect(out.join(" ")).toContain("✓ Daemon stopped");
  });
});

describe("daemon session verbs", () => {
  it("gate: daemon down → uniform daemon_down error, exit 1, nothing on stdout", async () => {
    client.isRunning.mockResolvedValue(false);
    const { writer, out, err } = memoryWriter();
    process.exitCode = 0;
    await sessionList({ json: true }, writer);
    expect(out).toEqual([]);
    expect(JSON.parse(err[0] as string)).toMatchObject({
      type: "error",
      code: "daemon_down",
    });
    expect(process.exitCode).toBe(1);
  });

  it("list --json preserves the legacy {sessions:[…]} envelope on one line", async () => {
    client.isRunning.mockResolvedValue(true);
    const sessions = [
      {
        sessionId: "s1",
        parentId: null,
        forkPoint: null,
        status: "active",
        eventCount: 3,
        createdAt: 1,
      },
    ];
    client.listSessions.mockResolvedValue({ sessions });
    const { writer, out } = memoryWriter();
    await sessionList({ json: true }, writer);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] as string)).toEqual({ sessions });
  });

  it("list pretty renders rows with lineage, and the empty hint", async () => {
    client.isRunning.mockResolvedValue(true);
    client.listSessions.mockResolvedValue({
      sessions: [
        {
          sessionId: "s2",
          parentId: "s1",
          forkPoint: 4,
          status: "active",
          eventCount: 7,
          createdAt: 1,
        },
      ],
    });
    const { writer, out } = memoryWriter();
    await sessionList({}, writer);
    expect(out.join("\n")).toContain(
      "s2  active  7 event(s) (forked from s1 @4)",
    );

    client.listSessions.mockResolvedValue({ sessions: [] });
    const empty = memoryWriter();
    await sessionList({}, empty.writer);
    expect(empty.out.join(" ")).toContain("No sessions recorded yet");
  });

  it("fork emits the result envelope; failure is exit 1 on stderr", async () => {
    client.isRunning.mockResolvedValue(true);
    client.forkSession.mockResolvedValue({
      sessionId: "s3",
      parentId: "s1",
      forkPoint: 2,
    });
    const { writer, out } = memoryWriter();
    await sessionFork("s1", 2, { json: true }, writer);
    expect(JSON.parse(out[0] as string)).toEqual({
      sessionId: "s3",
      parentId: "s1",
      forkPoint: 2,
    });

    client.forkSession.mockRejectedValue(new Error("no such session"));
    const bad = memoryWriter();
    process.exitCode = 0;
    await sessionFork("sX", 1, {}, bad.writer);
    expect(bad.err.join(" ")).toContain("Fork failed: no such session");
    expect(process.exitCode).toBe(1);
  });

  it("replay emits the envelope / verdict lines", async () => {
    client.isRunning.mockResolvedValue(true);
    const payload = {
      replay: { deterministic: true, stepsReplayed: 5, divergences: [] },
      turns: [
        {
          turnId: "t1",
          compileMs: 12,
          tokens: 900,
          cacheHitRate: 0.5,
          toolCalls: 2,
          outcome: "ok",
        },
      ],
    };
    client.replaySession.mockResolvedValue(payload);
    const { writer, out } = memoryWriter();
    await sessionReplay("s1", { json: true }, writer);
    expect(JSON.parse(out[0] as string)).toEqual(payload);

    const pretty = memoryWriter();
    await sessionReplay("s1", {}, pretty.writer);
    const text = pretty.out.join("\n");
    expect(text).toContain("deterministic ✓ across 5 compiled step(s)");
    expect(text).toContain("turn t1: 12ms compile, 900 tokens, 50% cache hit");
  });
});
