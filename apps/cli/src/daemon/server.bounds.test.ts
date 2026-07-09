/**
 * Daemon lifecycle-bound tests — the in-memory session registry cap, the
 * per-connection line-buffer cap, and the RSS watchdog config plumb-through.
 * Mirrors server.session.test.ts's real-socket harness.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskFrame } from "@oxagen/engram";
import { ContextDaemon } from "./server";
import { DaemonClient } from "./client";

let dir: string;
let socketPath: string;
let daemon: ContextDaemon;
let client: DaemonClient;

const NS = { org: "test-org", workspace: "test-ws" };

function taskFrame(sessionId: string): TaskFrame {
  return {
    namespace: NS,
    taskDescription: "bounds test",
    workingSet: [],
    recentEventIds: [],
    modelId: "claude-sonnet-5",
    sessionId,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-daemon-bounds-"));
  // Keep the socket path short (macOS caps Unix socket paths at ~104 bytes).
  socketPath = join(tmpdir(), `oxbnd${process.pid}.sock`);
  daemon = new ContextDaemon({
    socketPath,
    pidFile: join(dir, "d.pid"),
    logFile: join(dir, "d.log"),
    idleTimeoutMs: 60_000,
    workspaceRoot: dir,
    dbPath: join(dir, "ctx.duckdb"),
    codeGraphDbPath: join(dir, "cg.duckdb"),
    maxRssBytes: 0, // watchdog off — these tests exercise the other bounds
  });
  await daemon.start();
  client = new DaemonClient(socketPath);
});

afterEach(async () => {
  await daemon.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe("session registry cap", () => {
  it("evicts the oldest recorded session once the cap is reached", async () => {
    // Recording happens via compile() with a sessionId; drive it through the
    // real RPC path so eviction is proven end-to-end. 201 compiles crosses
    // the 200-session cap by exactly one.
    for (let i = 0; i < 201; i++) {
      await client.compile(taskFrame(`sess-${i}`));
    }
    const listed = (await client.listSessions()) as {
      sessions: { sessionId: string }[];
    };
    expect(listed.sessions).toHaveLength(200);
    const ids = new Set(listed.sessions.map((s) => s.sessionId));
    expect(ids.has("sess-0")).toBe(false); // oldest evicted
    expect(ids.has("sess-200")).toBe(true); // newest retained
  }, 60_000);
});

describe("socket line-buffer cap", () => {
  it("rejects a newline-free flood and drops the connection", async () => {
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));

    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    const closed = new Promise<void>((resolve) => {
      socket.once("close", resolve);
      // With writes still queued client-side, the auto-close after the
      // daemon's FIN can't finish flushing — treat the FIN itself as closure.
      socket.once("end", () => {
        socket.destroy();
        resolve();
      });
    });
    socket.on("error", () => {}); // the daemon drops the socket — expected

    // Stream > 8 MB without a single newline. Writes are NOT awaited: once
    // the daemon stops reading, awaiting a backpressured write would hang the
    // test — the pending bytes error out when the daemon closes the socket.
    const chunk = Buffer.alloc(1024 * 1024, "x");
    for (let i = 0; i < 9; i++) socket.write(chunk);

    await closed;
    const reply = Buffer.concat(received).toString("utf8");
    expect(reply).toContain("exceeds");
    // The daemon itself must survive the flood.
    const health = await client.send({ id: "h", method: "health", params: {} });
    expect((health.result as { status: string }).status).toBe("ok");
  }, 30_000);
});
