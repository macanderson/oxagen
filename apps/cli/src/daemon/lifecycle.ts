/**
 * Daemon lifecycle — start, stop, status commands.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { DaemonClient } from "./client.js";

const DAEMON_DIR = join(homedir(), ".config", "oxagen");
const SOCKET_PATH = join(DAEMON_DIR, "daemon.sock");
const PID_FILE = join(DAEMON_DIR, "daemon.pid");
const LOG_FILE = join(DAEMON_DIR, "daemon.log");
const DB_PATH = join(DAEMON_DIR, "context.duckdb");
const CODE_GRAPH_DB_PATH = join(DAEMON_DIR, "code-graph.duckdb");

function getClient(): DaemonClient {
  return new DaemonClient(SOCKET_PATH);
}

export async function startDaemon(opts: { foreground: boolean }): Promise<void> {
  const client = getClient();
  const running = await client.isRunning();

  if (running) {
    console.log("✓ Daemon is already running.");
    return;
  }

  if (opts.foreground) {
    // Run in foreground (blocks)
    const { ContextDaemon } = await import("./server.js");
    const daemon = new ContextDaemon({
      socketPath: SOCKET_PATH,
      pidFile: PID_FILE,
      logFile: LOG_FILE,
      idleTimeoutMs: 30 * 60 * 1000,
      workspaceRoot: process.cwd(),
      dbPath: DB_PATH,
      codeGraphDbPath: CODE_GRAPH_DB_PATH,
    });
    console.log("Starting context daemon (foreground)…");
    console.log(`  Socket: ${SOCKET_PATH}`);
    console.log(`  DB:     ${DB_PATH}`);
    await daemon.start();
    console.log("✓ Daemon running. Press Ctrl+C to stop.");

    // Keep alive until signal
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        void daemon.shutdown().then(resolve);
      });
      process.on("SIGTERM", () => {
        void daemon.shutdown().then(resolve);
      });
    });
  } else {
    // Daemonize: spawn detached child
    const child = spawn(
      process.execPath,
      [
        "--import", "tsx",
        import.meta.url.replace("file://", "").replace("lifecycle.js", "lifecycle.ts"),
        "--daemon-child",
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          OXAGEN_DAEMON_SOCKET: SOCKET_PATH,
          OXAGEN_DAEMON_PID: PID_FILE,
          OXAGEN_DAEMON_LOG: LOG_FILE,
          OXAGEN_DAEMON_DB: DB_PATH,
          OXAGEN_DAEMON_CODE_GRAPH_DB: CODE_GRAPH_DB_PATH,
          OXAGEN_DAEMON_CWD: process.cwd(),
        },
      },
    );
    child.unref();
    console.log(`✓ Daemon started (pid ${child.pid}).`);
    console.log(`  Socket: ${SOCKET_PATH}`);
  }
}

export async function stopDaemon(): Promise<void> {
  const client = getClient();
  const running = await client.isRunning();

  if (!running) {
    console.log("Daemon is not running.");
    return;
  }

  try {
    await client.shutdown();
    console.log("✓ Daemon stopped.");
  } catch {
    // Try SIGTERM via PID file
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, "utf8"), 10);
      try {
        process.kill(pid, "SIGTERM");
        console.log(`✓ Sent SIGTERM to daemon (pid ${pid}).`);
      } catch {
        console.log("Could not stop daemon. It may have already exited.");
      }
    }
  }
}

export async function daemonStatus(): Promise<void> {
  const client = getClient();
  const running = await client.isRunning();

  if (!running) {
    console.log("● Daemon is not running.");
    console.log(`  Socket: ${SOCKET_PATH}`);
    console.log(`  Start with: oxagen daemon start`);
    return;
  }

  try {
    const response = await client.send({ id: "status", method: "health", params: {} });
    const result = response.result as { status: string; uptime: number; pid: number } | undefined;
    if (result) {
      const uptime = formatUptime(result.uptime);
      console.log(`● Daemon is running (pid ${result.pid})`);
      console.log(`  Uptime:  ${uptime}`);
      console.log(`  Socket:  ${SOCKET_PATH}`);
      console.log(`  DB:      ${DB_PATH}`);
    }
  } catch (err) {
    console.log(`● Daemon status unknown: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Sessions — fork/replay/list a daemon-recorded compile session
// ---------------------------------------------------------------------------

interface SessionSummary {
  sessionId: string;
  parentId: string | null;
  forkPoint: number | null;
  status: string;
  eventCount: number;
  createdAt: number;
}

async function requireRunningDaemon(client: DaemonClient): Promise<boolean> {
  if (await client.isRunning()) return true;
  console.log("Daemon is not running. Start it with `oxagen daemon start`.");
  process.exitCode = 1;
  return false;
}

/** `oxagen daemon session list` — sessions recorded by the running daemon. */
export async function sessionList(opts: { json?: boolean } = {}): Promise<void> {
  const client = getClient();
  if (!(await requireRunningDaemon(client))) return;

  const result = (await client.listSessions()) as { sessions: SessionSummary[] };
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.sessions.length === 0) {
    console.log(
      "No sessions recorded yet. Sessions are recorded in-memory whenever `compile` is " +
        "called with a taskFrame.sessionId, and reset on daemon restart.",
    );
    return;
  }
  for (const s of result.sessions) {
    const lineage = s.parentId ? ` (forked from ${s.parentId} @${s.forkPoint})` : "";
    console.log(`${s.sessionId}  ${s.status}  ${s.eventCount} event(s)${lineage}`);
  }
}

/** `oxagen daemon session fork <sessionId> <forkPoint>` — branch a session's history. */
export async function sessionFork(
  sessionId: string,
  forkPoint: number,
  opts: { json?: boolean } = {},
): Promise<void> {
  const client = getClient();
  if (!(await requireRunningDaemon(client))) return;

  try {
    const result = (await client.forkSession(sessionId, forkPoint)) as {
      sessionId: string;
      parentId: string | null;
      forkPoint: number | null;
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`✓ Forked session ${result.parentId} at event ${result.forkPoint} -> new session ${result.sessionId}`);
  } catch (err) {
    console.log(`Fork failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

/** `oxagen daemon session replay <sessionId>` — determinism check + per-turn metrics. */
export async function sessionReplay(sessionId: string, opts: { json?: boolean } = {}): Promise<void> {
  const client = getClient();
  if (!(await requireRunningDaemon(client))) return;

  try {
    const result = (await client.replaySession(sessionId)) as {
      replay: { deterministic: boolean; stepsReplayed: number; divergences: unknown[] };
      turns: {
        turnId: string;
        compileMs: number;
        tokens: number;
        cacheHitRate: number;
        toolCalls: number;
        outcome: string;
      }[];
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const verdict = result.replay.deterministic
      ? "deterministic ✓"
      : `${result.replay.divergences.length} divergence(s) ✗`;
    console.log(`Session ${sessionId}: ${verdict} across ${result.replay.stepsReplayed} compiled step(s).`);
    for (const t of result.turns) {
      console.log(
        `  turn ${t.turnId}: ${t.compileMs}ms compile, ${t.tokens} tokens, ` +
          `${(t.cacheHitRate * 100).toFixed(0)}% cache hit, ${t.toolCalls} tool call(s), outcome=${t.outcome}`,
      );
    }
  } catch (err) {
    console.log(`Replay failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
