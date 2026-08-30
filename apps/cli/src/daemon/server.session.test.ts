/**
 * Daemon session RPC tests — prove the previously-stubbed session.fork /
 * session.replay / session.list handlers are live end-to-end over the real
 * Unix socket, backed by @oxagen/engram's forkSession/getFullHistory
 * (session/fork.ts) and analyzeReplay/extractTurnMetrics (session/replay.ts).
 *
 * `compile()` populates the daemon's in-memory session registry whenever the
 * taskFrame names a sessionId — mirrors server.code-graph.test.ts's pattern
 * for the graph.* RPCs (OXA-2071 sibling wiring).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskFrame } from "@oxagen/engram";
import { ContextDaemon } from "./server";
import { DaemonClient } from "./client";

// Every test here drives a real in-process daemon over a Unix socket; the
// compile()/list round-trips take milliseconds locally but can exceed the 5s
// vitest default when the full-gate `test` job starves the CI runner's CPU
// (the CLI suite has been observed taking ~18min under that load). Give the RPC
// round-trips generous headroom so load-induced slowness is not read as a hang.
vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let socketPath: string;
let daemon: ContextDaemon;
let client: DaemonClient;

const NS = { org: "test-org", workspace: "test-ws" };

function taskFrame(
  sessionId: string,
  overrides: Partial<TaskFrame> = {},
): TaskFrame {
  return {
    namespace: NS,
    taskDescription: "investigate a failing test",
    workingSet: [],
    recentEventIds: [],
    modelId: "claude-sonnet-5",
    sessionId,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-session-rpc-"));
  // Keep the socket path short (macOS caps Unix socket paths at ~104 bytes).
  socketPath = join(tmpdir(), `oxses${process.pid}.sock`);
  daemon = new ContextDaemon({
    socketPath,
    pidFile: join(dir, "d.pid"),
    logFile: join(dir, "d.log"),
    idleTimeoutMs: 60_000,
    workspaceRoot: dir,
    dbPath: join(dir, "ctx.duckdb"),
    codeGraphDbPath: join(dir, "cg.duckdb"),
  });
  await daemon.start();
  client = new DaemonClient(socketPath);
});

afterEach(async () => {
  await daemon.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe("session RPCs", () => {
  it("session.list is empty before any compile() names a session", async () => {
    const result = (await client.listSessions()) as { sessions: unknown[] };
    expect(result.sessions).toEqual([]);
  });

  // This is the first test in the file to actually call `compile()`, which
  // dynamically imports `@oxagen/engram` and constructs its DuckDB-backed
  // engines/store for the first time — a real, one-time cold-start cost that
  // the default 5000ms vitest timeout doesn't reliably cover under a loaded CI
  // runner (subsequent compiles in this file/process reuse the warmed module
  // cache and stay fast). A longer ceiling here, not a sleep, absorbs that.
  it("compile() with a sessionId records a turn, visible via session.list", async () => {
    await client.compile(taskFrame("sess-1"));

    const result = (await client.listSessions()) as {
      sessions: {
        sessionId: string;
        status: string;
        eventCount: number;
        parentId: string | null;
      }[];
    };
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: "sess-1",
      status: "active",
      parentId: null,
    });
    // session_start + turn_start + context_compiled + turn_end
    expect(result.sessions[0]!.eventCount).toBe(4);
  }, 20_000);

  it("compile() called twice on the same sessionId accumulates turns", async () => {
    await client.compile(taskFrame("sess-2"));
    await client.compile(taskFrame("sess-2"));

    const result = (await client.listSessions()) as {
      sessions: { eventCount: number }[];
    };
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.eventCount).toBe(7); // 1 session_start + 2x3 turn events
  });

  it("session.replay analyzes determinism and extracts per-turn metrics", async () => {
    await client.compile(taskFrame("sess-3"));

    const result = (await client.replaySession("sess-3")) as {
      replay: { deterministic: boolean; stepsReplayed: number };
      turns: {
        compileMs: number;
        tokens: number;
        toolCalls: number;
        outcome: string;
      }[];
      inheritedEventCount: number;
    };
    expect(result.replay.deterministic).toBe(true);
    expect(result.replay.stepsReplayed).toBe(1);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]!.outcome).toBe("success");
    expect(result.turns[0]!.toolCalls).toBe(0);
    expect(result.inheritedEventCount).toBe(0);
  });

  it("session.replay on an unknown session returns SESSION_NOT_FOUND", async () => {
    const response = await client.send({
      id: "r1",
      method: "session.replay",
      params: { sessionId: "does-not-exist" },
    });
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32001); // DAEMON_ERRORS.SESSION_NOT_FOUND
  });

  it("session.fork branches a session and getFullHistory inherits the parent prefix", async () => {
    await client.compile(taskFrame("sess-4"));
    await client.compile(taskFrame("sess-4"));

    const listBefore = (await client.listSessions()) as {
      sessions: { eventCount: number }[];
    };
    const parentEventCount = listBefore.sessions[0]!.eventCount;

    const forked = (await client.forkSession("sess-4", 2)) as {
      sessionId: string;
      parentId: string;
      forkPoint: number;
      status: string;
    };
    expect(forked.parentId).toBe("sess-4");
    expect(forked.forkPoint).toBe(2);
    expect(forked.status).toBe("active");

    const list = (await client.listSessions()) as {
      sessions: {
        sessionId: string;
        parentId: string | null;
        forkPoint: number | null;
      }[];
    };
    expect(list.sessions).toHaveLength(2);
    const forkedSummary = list.sessions.find(
      (s) => s.sessionId === forked.sessionId,
    );
    expect(forkedSummary).toMatchObject({ parentId: "sess-4", forkPoint: 2 });

    // The forked session's replay should report the parent's prefix as
    // inherited (getFullHistory), proving the fork lineage is queryable.
    const replay = (await client.replaySession(forked.sessionId)) as {
      inheritedEventCount: number;
    };
    expect(replay.inheritedEventCount).toBe(3); // events 0,1,2 of the parent
    expect(parentEventCount).toBeGreaterThan(3);
  });

  it("session.fork on an unknown session returns SESSION_NOT_FOUND", async () => {
    const response = await client.send({
      id: "f1",
      method: "session.fork",
      params: { sessionId: "does-not-exist", forkPoint: 0 },
    });
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32001);
  });
});
