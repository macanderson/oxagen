/**
 * data.ts — the real-data layer behind `oxagen view` (the agent audit
 * dashboard).
 *
 * Every number the dashboard shows is read here from a REAL local source, or it
 * is not shown at all:
 *
 *   - Agent runs / audit  ← the ADR-023 session store (`~/.oxagen/fleet/<hash>`,
 *     the same append-only event logs Mission Control and `oxagen fleet watch`
 *     read). This is the retrospective record of every interactive and fleet
 *     agent run in this project — start time, duration, turns, model, agent,
 *     token usage, cost, and outcome.
 *   - Recent activity     ← the newest session's real `events.ndjson`, folded to
 *     salient lines through the same {@link toAggregateLine} Mission Control uses.
 *   - Code graph          ← the daemon's DuckDB code-graph store, opened
 *     READ-ONLY. Real file/symbol/edge counts, embedding coverage, and last
 *     index time — or an explicit "absent" / "locked" / "empty" state.
 *   - Spend               ← the real per-session `usage.costUsd` totals, summed.
 *   - Auth                ← the same config/env the run paths read (platform
 *     login vs BYOK key vs signed-out).
 *   - Daemon health       ← an actual ping of the daemon socket.
 *
 * The split: the pure aggregation/formatting functions (summarize, rollup, auth
 * resolution, formatters) take plain data and are exhaustively unit-tested; the
 * IO probes (code graph, daemon) are injectable so tests never touch DuckDB or a
 * socket. `collectAgentViewData` wires the two together for the live view.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  SessionEvent,
  SessionState,
  TurnUsage,
} from "../../sessions/events.js";
import {
  isActiveState,
  openFleetStore,
  type SessionMetaView,
  type SessionStore,
} from "../../sessions/store.js";
import { fleetRoot, projectRoot } from "../../sessions/paths.js";
import { defaultCodeGraphDbPath } from "../../daemon/code-graph/store.js";
import { DaemonClient } from "../../daemon/client.js";
import {
  getOrgId,
  getToken,
  getWorkspaceId,
  readConfig,
} from "../../lib/config.js";
import {
  toAggregateLine,
  type AggregateEmphasis,
} from "../mission-control/aggregate-line.js";
import { countByState, type StateCounts } from "../mission-control/lib.js";

// ── Auth ─────────────────────────────────────────────────────────────────────

export type AuthMode = "platform" | "byok-gateway" | "byok-anthropic" | "none";

export interface AuthStatus {
  mode: AuthMode;
  orgSlug?: string;
  workspaceSlug?: string;
  /** A one-line human label for the status bar. */
  label: string;
  /** True when model calls can actually run (logged in OR a BYOK key present). */
  ok: boolean;
}

/** Inputs to {@link resolveAuthStatus}, injected so the precedence is testable. */
export interface AuthInput {
  token?: string | undefined;
  orgSlug?: string | undefined;
  workspaceSlug?: string | undefined;
  /** A gateway key (`AI_GATEWAY_API_KEY` / config) is present. */
  gatewayKey?: boolean;
  /** An Anthropic key (`ANTHROPIC_API_KEY` / config) is present. */
  anthropicKey?: boolean;
  /** `OXAGEN_LOCAL=1` — force BYOK even while logged in. */
  forceLocal?: boolean;
}

/**
 * Resolve the effective auth mode for a run started right now, mirroring the
 * precedence in `lib/session.ts::requireSession`: forced-local BYOK first, then
 * a complete platform session, then a BYOK key (gateway wins over Anthropic),
 * else signed-out.
 */
export function resolveAuthStatus(input: AuthInput): AuthStatus {
  const loggedIn = Boolean(input.token && input.orgSlug && input.workspaceSlug);
  const byok: AuthMode | null = input.gatewayKey
    ? "byok-gateway"
    : input.anthropicKey
      ? "byok-anthropic"
      : null;

  if (input.forceLocal && byok) {
    return { mode: byok, label: byokLabel(byok) + " (forced)", ok: true };
  }
  if (loggedIn) {
    return {
      mode: "platform",
      orgSlug: input.orgSlug as string,
      workspaceSlug: input.workspaceSlug as string,
      label: `${input.orgSlug} / ${input.workspaceSlug}`,
      ok: true,
    };
  }
  if (byok) return { mode: byok, label: byokLabel(byok), ok: true };
  return { mode: "none", label: "not signed in", ok: false };
}

function byokLabel(mode: "byok-gateway" | "byok-anthropic"): string {
  return mode === "byok-gateway" ? "BYOK · gateway" : "BYOK · anthropic";
}

/** Read the real auth status from config + env (no side effects). */
export function readAuthStatus(): AuthStatus {
  const cfg = readConfig();
  return resolveAuthStatus({
    token: getToken(),
    orgSlug: getOrgId(),
    workspaceSlug: getWorkspaceId(),
    gatewayKey: Boolean(process.env["AI_GATEWAY_API_KEY"] || cfg.gatewayKey),
    anthropicKey: Boolean(process.env["ANTHROPIC_API_KEY"] || cfg.anthropicKey),
    forceLocal: process.env["OXAGEN_LOCAL"] === "1",
  });
}

// ── Sessions (audit) ───────────────────────────────────────────────────────────

/** One agent run, distilled from a {@link SessionMetaView} for the audit table. */
export interface SessionRow {
  sid: string;
  title: string;
  state: SessionState | "orphaned";
  /** True while the run can still emit events (queued/running/waiting). */
  live: boolean;
  /** `worker` = a detached fleet run; `tui` = an interactive REPL session. */
  owner: "tui" | "worker";
  model?: string;
  agent?: string;
  turns: number;
  startedAt: number;
  /** Wall-clock duration: finished runs use their end; live runs count to now. */
  durationMs: number;
  usage: TurnUsage;
  summary?: string;
  lastActivity?: string;
  updatedAt: number;
}

/** Distill one on-disk session into an audit row. Pure. */
export function summarizeSession(
  meta: SessionMetaView,
  now: number,
): SessionRow {
  const end =
    meta.endedAt ?? (isActiveState(meta.derivedState) ? now : meta.updatedAt);
  return {
    sid: meta.sid,
    title: meta.title,
    state: meta.derivedState,
    live: isActiveState(meta.derivedState),
    owner: meta.owner,
    ...(meta.model !== undefined ? { model: meta.model } : {}),
    ...(meta.agent !== undefined ? { agent: meta.agent } : {}),
    turns: meta.turns,
    startedAt: meta.createdAt,
    durationMs: Math.max(0, end - meta.createdAt),
    usage: meta.usage,
    ...(meta.summary !== undefined ? { summary: meta.summary } : {}),
    ...(meta.lastActivity !== undefined
      ? { lastActivity: meta.lastActivity }
      : {}),
    updatedAt: meta.updatedAt,
  };
}

/** Fleet-wide rollup across every recorded run — the overview panel's numbers. */
export interface SessionRollup {
  total: number;
  byState: StateCounts;
  /** Runs still able to emit events right now. */
  active: number;
  /** Detached fleet runs (`owner === "worker"`). */
  fleetRuns: number;
  /** Interactive REPL runs (`owner === "tui"`). */
  interactiveRuns: number;
  costUsdTotal: number;
  /** Spend from runs started since local midnight. */
  costUsdToday: number;
  inputTokens: number;
  outputTokens: number;
  /** The most recent `updatedAt` across all runs, or null when there are none. */
  lastActivityAt: number | null;
}

function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Aggregate rows into the overview rollup. Pure. */
export function rollupSessions(
  rows: readonly SessionRow[],
  now: number,
): SessionRollup {
  const byState: StateCounts = {
    running: 0,
    waiting: 0,
    queued: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    orphaned: 0,
  };
  const dayStart = startOfLocalDay(now);
  let costUsdTotal = 0;
  let costUsdToday = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let fleetRuns = 0;
  let interactiveRuns = 0;
  let active = 0;
  let lastActivityAt: number | null = null;

  for (const r of rows) {
    byState[r.state] += 1;
    costUsdTotal += r.usage.costUsd;
    inputTokens += r.usage.inputTokens;
    outputTokens += r.usage.outputTokens;
    if (r.startedAt >= dayStart) costUsdToday += r.usage.costUsd;
    if (r.owner === "worker") fleetRuns += 1;
    else interactiveRuns += 1;
    if (r.live) active += 1;
    if (lastActivityAt === null || r.updatedAt > lastActivityAt)
      lastActivityAt = r.updatedAt;
  }

  return {
    total: rows.length,
    byState,
    active,
    fleetRuns,
    interactiveRuns,
    costUsdTotal,
    costUsdToday,
    inputTokens,
    outputTokens,
    lastActivityAt,
  };
}

// ── Recent activity (from real event logs) ─────────────────────────────────────

export interface ActivityLine {
  sid: string;
  ts: number;
  text: string;
  emphasis: AggregateEmphasis;
}

/**
 * Fold a session's real event stream into the last `limit` salient lines, using
 * the exact same salience rules as Mission Control's aggregate timeline.
 */
export function recentActivity(
  events: readonly SessionEvent[],
  limit: number,
): ActivityLine[] {
  const lines: ActivityLine[] = [];
  for (const e of events) {
    const al = toAggregateLine(e, { verbose: false });
    if (al) lines.push(al);
  }
  return lines.slice(-limit);
}

// ── Code graph probe ───────────────────────────────────────────────────────────

export type CodeGraphStatus =
  | { state: "absent"; dbPath: string }
  | { state: "locked"; dbPath: string }
  | { state: "empty"; dbPath: string; root: string }
  | {
      state: "ready";
      dbPath: string;
      root: string;
      files: number;
      symbols: number;
      edges: number;
      embeddedFiles: number;
      lastIndexedAt: number | null;
    };

// ── Daemon probe ───────────────────────────────────────────────────────────────

export interface DaemonStatus {
  running: boolean;
  socketPath: string;
  pid?: number;
  uptimeSeconds?: number;
}

// ── Aggregate snapshot ─────────────────────────────────────────────────────────

export interface AgentViewData {
  auth: AuthStatus;
  rows: SessionRow[];
  rollup: SessionRollup;
  activity: ActivityLine[];
  codeGraph: CodeGraphStatus;
  daemon: DaemonStatus;
  /** The per-project fleet root these runs were read from. */
  fleetRoot: string;
  /** The resolved project root (nearest `.git` ancestor of cwd). */
  projectRoot: string;
  generatedAt: number;
  /** Set when the session store could not be read, so the failure is visible instead of hidden. */
  sourceError?: string;
}

export interface CollectDeps {
  cwd: string;
  now?: number;
  /** Override the session store (tests point this at a tmpdir store). */
  store?: SessionStore;
  /** Override the resolved auth status. */
  auth?: AuthStatus;
  /** Override the code-graph probe (default opens DuckDB read-only). */
  probeCodeGraph?: () => Promise<CodeGraphStatus>;
  /** Override the daemon probe (default pings the daemon socket). */
  probeDaemon?: () => Promise<DaemonStatus>;
  /** How many recent activity lines to keep (default 12). */
  activityLimit?: number;
}

/**
 * Gather one snapshot for the dashboard. Session reads are real; the two
 * IO probes default to the live implementations but are injectable so unit
 * tests exercise the aggregation without DuckDB or a socket.
 */
export async function collectAgentViewData(
  deps: CollectDeps,
): Promise<AgentViewData> {
  const now = deps.now ?? Date.now();
  const root = projectRoot(deps.cwd);
  const store = deps.store ?? openFleetStore(fleetRoot(deps.cwd));
  const auth = deps.auth ?? readAuthStatus();

  let metas: SessionMetaView[] = [];
  let sourceError: string | undefined;
  try {
    metas = await store.listSessions();
  } catch (err) {
    sourceError = err instanceof Error ? err.message : String(err);
  }

  const rows = metas.map((m) => summarizeSession(m, now));
  const rollup = rollupSessions(rows, now);

  // Recent activity comes from the single most-recently-touched session — one
  // small file read, cheap enough for a 2–5 s refresh.
  let activity: ActivityLine[] = [];
  const newest = metas.reduce<SessionMetaView | null>(
    (best, m) => (best === null || m.updatedAt > best.updatedAt ? m : best),
    null,
  );
  if (newest) {
    try {
      const events = await store.readEvents(newest.sid);
      activity = recentActivity(events, deps.activityLimit ?? 12);
    } catch {
      // A vanished/torn log is not fatal — the panel just shows no activity.
    }
  }

  const codeGraph = deps.probeCodeGraph
    ? await deps.probeCodeGraph()
    : await defaultProbeCodeGraph(deps.cwd);
  const daemon = deps.probeDaemon
    ? await deps.probeDaemon()
    : await defaultProbeDaemon();

  return {
    auth,
    rows,
    rollup,
    activity,
    codeGraph,
    daemon,
    fleetRoot: store.rootDir,
    projectRoot: root,
    generatedAt: now,
    ...(sourceError !== undefined ? { sourceError } : {}),
  };
}

// ── Live IO probes (production defaults) ───────────────────────────────────────

const DAEMON_DIR = join(homedir(), ".config", "oxagen");
const DAEMON_SOCKET = join(DAEMON_DIR, "daemon.sock");

/** Actually ping the daemon socket — never assume it is up. */
async function defaultProbeDaemon(): Promise<DaemonStatus> {
  const client = new DaemonClient(DAEMON_SOCKET);
  const running = await client.isRunning().catch(() => false);
  if (!running) return { running: false, socketPath: DAEMON_SOCKET };
  try {
    const res = await client.send({ id: "view", method: "health", params: {} });
    const r = res.result as { pid?: number; uptime?: number } | undefined;
    return {
      running: true,
      socketPath: DAEMON_SOCKET,
      ...(typeof r?.pid === "number" ? { pid: r.pid } : {}),
      ...(typeof r?.uptime === "number" ? { uptimeSeconds: r.uptime } : {}),
    };
  } catch {
    return { running: true, socketPath: DAEMON_SOCKET };
  }
}

// Minimal structural types for the (native, CJS) `duckdb` module opened
// READ-ONLY — mirrors the surface `daemon/code-graph/store.ts` describes, plus
// the config+callback constructor overload the read-only open needs.
interface DuckConnRO {
  all(sql: string, ...args: unknown[]): void;
  close(cb: (err: Error | null) => void): void;
}
interface DuckDatabaseRO {
  connect(): DuckConnRO;
  close(cb: (err: Error | null) => void): void;
}
interface DuckModuleRO {
  Database: new (
    path: string,
    config: Record<string, string>,
    cb: (err: Error | null) => void,
  ) => DuckDatabaseRO;
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The plausible `root` keys the daemon may have stored the graph under. */
function candidateRoots(cwd: string): string[] {
  const root = projectRoot(cwd);
  return [...new Set([cwd, realpathSafe(cwd), root, realpathSafe(root)])];
}

/** The live default: probe the daemon's code-graph store at its canonical path. */
function defaultProbeCodeGraph(cwd: string): Promise<CodeGraphStatus> {
  return probeCodeGraphAt(defaultCodeGraphDbPath(), cwd);
}

/**
 * Open a code-graph DuckDB file READ-ONLY and report real counts for `cwd`'s
 * repo. Read-only never mutates and never blocks the daemon's writes; an absent
 * file says so, and a file that can't be opened/read right now (a daemon write
 * lock, an unloadable driver, or a corrupt file) reports `locked` rather than
 * inventing a healthy state. Exported so the real read path is unit-tested
 * against a genuine DuckDB file, not only mocked.
 */
export async function probeCodeGraphAt(
  dbPath: string,
  cwd: string,
): Promise<CodeGraphStatus> {
  if (!existsSync(dbPath)) return { state: "absent", dbPath };

  let duckdb: DuckModuleRO;
  try {
    // duckdb is a native CJS module; require() is shimmed in the CLI entry point.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- duckdb uses CJS
    duckdb = require("duckdb") as DuckModuleRO;
  } catch {
    return { state: "locked", dbPath };
  }

  return new Promise<CodeGraphStatus>((resolve) => {
    let db: DuckDatabaseRO;
    try {
      db = new duckdb.Database(dbPath, { access_mode: "READ_ONLY" }, (err) => {
        if (err) {
          resolve({ state: "locked", dbPath });
          return;
        }
        void queryCodeGraphStats(db, cwd, dbPath)
          .then(resolve)
          .catch(() => resolve({ state: "locked", dbPath }));
      });
    } catch {
      resolve({ state: "locked", dbPath });
    }
  });
}

async function queryCodeGraphStats(
  db: DuckDatabaseRO,
  cwd: string,
  dbPath: string,
): Promise<CodeGraphStatus> {
  const conn = db.connect();
  const query = (
    sql: string,
    params: unknown[] = [],
  ): Promise<Record<string, unknown>[]> =>
    new Promise((resolve, reject) => {
      conn.all(
        sql,
        ...params,
        (err: Error | null, rows: Record<string, unknown>[]) =>
          err ? reject(err) : resolve(rows ?? []),
      );
    });

  try {
    // Every aggregate is CAST to DOUBLE: DuckDB returns COUNT/HUGEINT values the
    // native duckdb-node binding cannot serialize ("Do not know how to serialize
    // a BigInt"), which aborts the PROCESS — not a catchable error. DOUBLE comes
    // back as a plain JS number; file counts and ms timestamps are well within
    // its exact-integer range.
    const nodeRows = await query(
      `SELECT root,
              CAST(count(*) FILTER (WHERE kind = 'file') AS DOUBLE) AS files,
              CAST(count(*) FILTER (WHERE kind <> 'file') AS DOUBLE) AS symbols,
              CAST(count(*) FILTER (WHERE kind = 'file' AND embedding IS NOT NULL) AS DOUBLE) AS embedded
       FROM code_nodes GROUP BY root`,
    );

    const candidates = new Set(candidateRoots(cwd));
    const mine = nodeRows
      .filter((r) => candidates.has(String(r["root"])))
      .sort((a, b) => Number(b["files"] ?? 0) - Number(a["files"] ?? 0));
    const chosen = mine.find((r) => Number(r["files"] ?? 0) > 0);

    if (!chosen) {
      return { state: "empty", dbPath, root: projectRoot(cwd) };
    }

    const root = String(chosen["root"]);
    const edgeRows = await query(
      "SELECT CAST(count(*) AS DOUBLE) AS cnt FROM code_edges WHERE root = ?",
      [root],
    );
    const idxRows = await query(
      "SELECT CAST(max(indexed_at) AS DOUBLE) AS last FROM code_files WHERE root = ?",
      [root],
    );
    const last = idxRows[0]?.["last"];

    return {
      state: "ready",
      dbPath,
      root,
      files: Number(chosen["files"] ?? 0),
      symbols: Number(chosen["symbols"] ?? 0),
      edges: Number(
        (edgeRows[0] as Record<string, unknown> | undefined)?.["cnt"] ?? 0,
      ),
      embeddedFiles: Number(chosen["embedded"] ?? 0),
      lastIndexedAt: last == null ? null : Number(last),
    };
  } finally {
    conn.close(() => {});
    db.close(() => {});
  }
}

// ── Formatters (pure, shared by the panels) ────────────────────────────────────

/** `1234` → `"1.2k"`, `2_500_000` → `"2.5M"`. Whole numbers stay whole. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// USD formatting: the canonical engine formatter, re-exported so this
// dashboard renders costs identically to every other repl/tui panel.
export { formatUsd } from "../../agent/model-router.js";

/** Relative age: `just now` / `12s ago` / `5m ago` / `3h ago` / `2d ago`. */
export function formatAge(ts: number, now: number): string {
  const ms = Math.max(0, now - ts);
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export { countByState };
export type { StateCounts };
