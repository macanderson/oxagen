// Read path for durable-sandbox command output (docs/specs/sandbox-session-lifecycle/spec.md
// §7.2). The sandbox inspector's log console calls fetchSandboxLogs; the write
// path is insertSandboxLogs in ./clickhouse (fired from ModalSandboxWorkspace.exec).
import { clickhouse } from "./clickhouse";

export type SandboxLogLevel = "normal" | "debug";

export interface SandboxLogLine {
  /** 'YYYY-MM-DD HH:MM:SS.mmm' (UTC) as ClickHouse renders DateTime64(3). */
  ts: string;
  stream: "stdout" | "stderr" | "system";
  level: SandboxLogLevel;
  command: string;
  seq: number;
  line: string;
  exitCode: number | null;
  durationMs: number | null;
}

// A durable session is short-lived (minutes to hours), so a 24h default window
// comfortably covers "show me this session's logs" without scanning old partitions.
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 500;

function clampLimit(n?: number): number {
  if (!n || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** Epoch-ms → ClickHouse DateTime64(3) literal ('YYYY-MM-DD HH:MM:SS.mmm', UTC). */
function chDateTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Fetch a durable session's captured command output, newest first, returned in
 * chronological order for a log console. When `level === 'normal'`, debug rows
 * (command echoes, timings, plumbing) are excluded — the inspector's Debug
 * toggle OFF. Tenant-scoped: callers pass the resolved org/workspace.
 */
export async function fetchSandboxLogs(args: {
  orgId: string;
  workspaceId: string;
  sessionId: string;
  level?: SandboxLogLevel;
  limit?: number;
  sinceMs?: number;
}): Promise<SandboxLogLine[]> {
  if (!args.sessionId) return [];
  const limit = clampLimit(args.limit);
  const since = args.sinceMs ?? Date.now() - DEFAULT_LOOKBACK_MS;
  // Default (undefined level) includes all rows; 'debug' also means "all".
  const normalOnly = args.level === "normal";

  const result = await clickhouse().query({
    query: `
      SELECT
        toString(ts) AS ts_text,
        stream,
        level,
        command,
        seq,
        line,
        exit_code,
        duration_ms
      FROM sandbox_log_events
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND session_id = {sessionId:String}
        AND ts >= {since:DateTime64(3)}
        ${normalOnly ? "AND level = 'normal'" : ""}
      ORDER BY ts DESC, seq DESC
      LIMIT {limit:UInt32}
    `,
    query_params: {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      since: chDateTime(since),
      limit,
    },
    format: "JSONEachRow",
  });

  interface Raw {
    // Aliased `ts_text` (not `ts`) so the raw DateTime64 column stays bound in
    // the WHERE/ORDER BY clauses. A `toString(ts) AS ts` alias shadows the
    // column, making ClickHouse compare the String alias against the
    // `{since:DateTime64(3)}` param — "No operation greaterOrEquals between
    // String and DateTime64(3)".
    ts_text: string;
    stream: string;
    level: string;
    command: string;
    seq: number;
    line: string;
    exit_code: number | null;
    duration_ms: number | null;
  }
  const rows = (await result.json()) as Raw[];
  // Fetched newest-first for the tail; hand back oldest-first for the console.
  return rows.reverse().map((r) => ({
    ts: r.ts_text,
    stream: (r.stream === "stderr" || r.stream === "system"
      ? r.stream
      : "stdout") as SandboxLogLine["stream"],
    level: r.level === "debug" ? "debug" : "normal",
    command: r.command,
    seq: Number(r.seq),
    line: r.line,
    exitCode: r.exit_code == null ? null : Number(r.exit_code),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
  }));
}
