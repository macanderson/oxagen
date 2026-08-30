/**
 * Daemon JSON-RPC protocol types.
 *
 * The context daemon communicates with CLI processes over a Unix socket
 * using a simple JSON-RPC-like protocol: one JSON object per request,
 * one JSON object per response, newline-delimited.
 */
import type { TaskFrame, TokenBudget } from "@oxagen/engram";

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type DaemonRequest =
  | {
      id: string;
      method: "compile";
      params: { taskFrame: TaskFrame; budget: TokenBudget };
    }
  | {
      id: string;
      method: "query";
      params: {
        namespace: { org: string; workspace: string };
        kinds?: string[];
        limit?: number;
      };
    }
  | { id: string; method: "recall"; params: { recordId: string } }
  | {
      id: string;
      method: "remember";
      params: { event: unknown; opts: unknown };
    }
  | {
      id: string;
      method: "session.fork";
      params: { sessionId: string; forkPoint: number };
    }
  | { id: string; method: "session.replay"; params: { sessionId: string } }
  | { id: string; method: "session.list"; params: Record<string, never> }
  | { id: string; method: "graph.build"; params: { root?: string } }
  | {
      id: string;
      method: "graph.query";
      params: {
        nodeId: string;
        hops?: number;
        edgeTypes?: string[];
        root?: string;
      };
    }
  | {
      id: string;
      method: "search_graph";
      params: { pattern: string; limit?: number; root?: string };
    }
  | { id: string; method: "health"; params: Record<string, never> }
  | { id: string; method: "shutdown"; params: Record<string, never> };

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface DaemonResponse {
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const DAEMON_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
  NOT_READY: -32000,
  SESSION_NOT_FOUND: -32001,
  RECORD_NOT_FOUND: -32002,
} as const;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface DaemonConfig {
  /** Socket path. Default: ~/.oxagen/daemon.sock */
  socketPath: string;
  /** PID file path. Default: ~/.oxagen/daemon.pid */
  pidFile: string;
  /** Log file path. Default: ~/.oxagen/daemon.log */
  logFile: string;
  /** Auto-stop after inactivity (ms). Default: 30 minutes. */
  idleTimeoutMs: number;
  /** Workspace root for code graph. */
  workspaceRoot: string;
  /** DuckDB path for persistent state (episodic/context store). */
  dbPath: string;
  /** DuckDB path for the persistent code graph (separate file to avoid lock
   *  contention with the context store). Default: ~/.config/oxagen/code-graph.duckdb */
  codeGraphDbPath: string;
  /**
   * RSS ceiling in bytes for the daemon process (0 disables). Defaults to
   * OXAGEN_DAEMON_MAX_RSS_MB (megabytes) or 2 GB — the daemon is the CLI's
   * one always-on process, so it carries its own memory watchdog: warn at
   * 80%, graceful shutdown at the ceiling.
   */
  maxRssBytes?: number;
}

export const DEFAULT_DAEMON_CONFIG: Pick<DaemonConfig, "idleTimeoutMs"> = {
  idleTimeoutMs: 30 * 60 * 1000,
};
