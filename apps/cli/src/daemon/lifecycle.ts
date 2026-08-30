/**
 * Daemon lifecycle — start, stop, status, and the recorded-session commands.
 *
 * Every handler is writer-parameterized (REPL-bridge safe) and speaks both
 * modes. `--json` emits ONE single-line JSON value on stdout, byte-compatible
 * for jq consumers, for every subcommand. Human confirmations and progress go
 * to stderr via `info`; the status/list/replay ANSWERS render on stdout in
 * pretty mode; failures are uniform stderr error lines with exit 1. See
 * ../../../docs/adr/ADR-023-cli-fleet-session-event-log.md §4.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { DaemonClient } from "./client.js";
import { DEFAULT_DAEMON_CONFIG } from "./protocol.js";
import { createOutput, type Output } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

const DAEMON_DIR = join(homedir(), ".config", "oxagen");
const SOCKET_PATH = join(DAEMON_DIR, "daemon.sock");
const PID_FILE = join(DAEMON_DIR, "daemon.pid");
const LOG_FILE = join(DAEMON_DIR, "daemon.log");
const DB_PATH = join(DAEMON_DIR, "context.duckdb");
const CODE_GRAPH_DB_PATH = join(DAEMON_DIR, "code-graph.duckdb");

function getClient(): DaemonClient {
  return new DaemonClient(SOCKET_PATH);
}

export interface DaemonJsonOptions {
  json?: boolean;
}

export async function startDaemon(
  opts: { foreground: boolean } & DaemonJsonOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const client = getClient();
  const running = await client.isRunning();

  if (running) {
    out.data(
      { running: true, started: false, socket: SOCKET_PATH },
      () => "✓ Daemon is already running.",
    );
    return;
  }

  if (opts.foreground) {
    // Run in foreground (blocks). Boot narration is progress → stderr; the
    // process itself is the "answer", so stdout stays quiet.
    const { ContextDaemon } = await import("./server.js");
    const daemon = new ContextDaemon({
      ...DEFAULT_DAEMON_CONFIG,
      socketPath: SOCKET_PATH,
      pidFile: PID_FILE,
      logFile: LOG_FILE,
      workspaceRoot: process.cwd(),
      dbPath: DB_PATH,
      codeGraphDbPath: CODE_GRAPH_DB_PATH,
    });
    out.info("Starting context daemon (foreground)…");
    out.info(`  Socket: ${SOCKET_PATH}`);
    out.info(`  DB:     ${DB_PATH}`);
    await daemon.start();
    out.info("✓ Daemon running. Press Ctrl+C to stop.");

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
        "--import",
        "tsx",
        import.meta.url
          .replace("file://", "")
          .replace("lifecycle.js", "lifecycle.ts"),
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
    out.data(
      {
        running: true,
        started: true,
        pid: child.pid ?? null,
        socket: SOCKET_PATH,
      },
      () => `✓ Daemon started (pid ${child.pid}).\n  Socket: ${SOCKET_PATH}`,
    );
  }
}

export async function stopDaemon(
  opts: DaemonJsonOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const client = getClient();
  const running = await client.isRunning();

  if (!running) {
    out.data(
      { running: false, stopped: false },
      () => "Daemon is not running.",
    );
    return;
  }

  try {
    await client.shutdown();
    out.data({ running: false, stopped: true }, () => "✓ Daemon stopped.");
  } catch {
    // Try SIGTERM via PID file
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, "utf8"), 10);
      try {
        process.kill(pid, "SIGTERM");
        out.data(
          { running: false, stopped: true, signalled: pid },
          () => `✓ Sent SIGTERM to daemon (pid ${pid}).`,
        );
      } catch {
        out.error("Could not stop daemon. It may have already exited.");
      }
    } else {
      out.error("Could not stop daemon (no PID file).");
    }
  }
}

export async function daemonStatus(
  opts: DaemonJsonOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const client = getClient();
  const running = await client.isRunning();

  if (!running) {
    out.data(
      { running: false, socket: SOCKET_PATH },
      () =>
        `● Daemon is not running.\n  Socket: ${SOCKET_PATH}\n  Start with: oxagen daemon start`,
    );
    return;
  }

  try {
    const response = await client.send({
      id: "status",
      method: "health",
      params: {},
    });
    const result = response.result as
      | { status: string; uptime: number; pid: number }
      | undefined;
    if (result) {
      out.data(
        {
          running: true,
          pid: result.pid,
          uptimeSeconds: result.uptime,
          socket: SOCKET_PATH,
          db: DB_PATH,
        },
        () =>
          `● Daemon is running (pid ${result.pid})\n` +
          `  Uptime:  ${formatUptime(result.uptime)}\n` +
          `  Socket:  ${SOCKET_PATH}\n` +
          `  DB:      ${DB_PATH}`,
      );
    }
  } catch (err) {
    out.error(
      `Daemon status unknown: ${err instanceof Error ? err.message : String(err)}`,
    );
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

async function requireRunningDaemon(
  client: DaemonClient,
  out: Output,
): Promise<boolean> {
  if (await client.isRunning()) return true;
  out.error(
    "Daemon is not running. Start it with `oxagen daemon start`.",
    "daemon_down",
  );
  return false;
}

/** `oxagen daemon session list` — sessions recorded by the running daemon. */
export async function sessionList(
  opts: DaemonJsonOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const client = getClient();
  if (!(await requireRunningDaemon(client, out))) return;

  const result = (await client.listSessions()) as {
    sessions: SessionSummary[];
  };
  if (out.isJson) {
    out.data(result); // jq consumers expect the {sessions: […]} envelope
    return;
  }
  if (result.sessions.length === 0) {
    writer.write(
      "No sessions recorded yet. Sessions are recorded in-memory whenever `compile` is " +
        "called with a taskFrame.sessionId, and reset on daemon restart.",
    );
    return;
  }
  for (const s of result.sessions) {
    const lineage = s.parentId
      ? ` (forked from ${s.parentId} @${s.forkPoint})`
      : "";
    writer.write(
      `${s.sessionId}  ${s.status}  ${s.eventCount} event(s)${lineage}`,
    );
  }
}

/** `oxagen daemon session fork <sessionId> <forkPoint>` — branch a session's history. */
export async function sessionFork(
  sessionId: string,
  forkPoint: number,
  opts: DaemonJsonOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const client = getClient();
  if (!(await requireRunningDaemon(client, out))) return;

  try {
    const result = (await client.forkSession(sessionId, forkPoint)) as {
      sessionId: string;
      parentId: string | null;
      forkPoint: number | null;
    };
    out.data(
      result,
      () =>
        `✓ Forked session ${result.parentId} at event ${result.forkPoint} -> new session ${result.sessionId}`,
    );
  } catch (err) {
    out.error(
      `Fork failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** `oxagen daemon session replay <sessionId>` — determinism check + per-turn metrics. */
export async function sessionReplay(
  sessionId: string,
  opts: DaemonJsonOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const client = getClient();
  if (!(await requireRunningDaemon(client, out))) return;

  try {
    const result = (await client.replaySession(sessionId)) as {
      replay: {
        deterministic: boolean;
        stepsReplayed: number;
        divergences: unknown[];
      };
      turns: {
        turnId: string;
        compileMs: number;
        tokens: number;
        cacheHitRate: number;
        toolCalls: number;
        outcome: string;
      }[];
    };
    out.data(result, () => {
      const verdict = result.replay.deterministic
        ? "deterministic ✓"
        : `${result.replay.divergences.length} divergence(s) ✗`;
      const lines = [
        `Session ${sessionId}: ${verdict} across ${result.replay.stepsReplayed} compiled step(s).`,
      ];
      for (const t of result.turns) {
        lines.push(
          `  turn ${t.turnId}: ${t.compileMs}ms compile, ${t.tokens} tokens, ` +
            `${(t.cacheHitRate * 100).toFixed(0)}% cache hit, ${t.toolCalls} tool call(s), outcome=${t.outcome}`,
        );
      }
      return lines.join("\n");
    });
  } catch (err) {
    out.error(
      `Replay failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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
