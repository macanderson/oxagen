/**
 * One `oxagen agent backfill` pass inside the daemon (ADR-161,
 * `docs/specs/tacho/backfill.md`).
 *
 * The transcript tailer reads the transcripts of the sessions the registry
 * holds: every session a hook, an OTel record, the model proxy, or the
 * detector met after the daemon started. It never lists `~/.claude/projects`
 * for files that do not move, so a session that ended before the host
 * enrolled, and never resumed, is never read. A pass reads those.
 *
 * For each transcript it decides, in order:
 *
 * 1. The daemon holds the session (a registry entry, a chain tombstone, a
 *    tailer cursor, or a WAL file this ledger did not write): skipped, the
 *    live path owns it.
 * 2. The file changed in the last 15 minutes: skipped as possibly active.
 * 3. This host's cursor file says a pass sealed it: skipped, or resumed when
 *    that pass stopped partway.
 * 4. The control plane holds it (`list_tacho_session_heads`): skipped. A host
 *    whose `TACHO_HOME` was wiped has no cursor file, and ingest answers a
 *    second chain at seq 0 for a session it holds as a chain break, so a pass
 *    that cannot ask seals nothing (a dry run still reports).
 *
 * The rest are read as streams, sealed by a backfill-mode recorder through
 * `TranscriptBackfill`, and appended to the WAL like live frames, so the
 * shipper sends them. Each slice of at most `SEAL_SLICE_BYTES` is sealed on
 * the session's own hook queue, with a turn of the event loop between slices
 * (ADR-231). Reading stops while the WAL holds more than
 * `BACKLOG_PAUSE_EVENTS` unshipped events.
 *
 * The cursor file records where each transcript was read to and where its
 * chain ends. A pass that stopped partway resumes by reading the file again
 * from byte 0: the frames are deterministic, so the replay seals the same
 * events, and those the WAL already holds are dropped after their hashes are
 * checked against it. A live resume of a backfilled session continues the
 * chain and the read position from the same file (`adoptedChain`,
 * `adoptedCursor`).
 *
 * Nothing here prints or returns transcript text: the report is counts, the
 * project directory names, and dates.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ChainCursor } from "../chain";
import {
  addTally,
  BACKFILL_NORMALIZER_VERSION,
  BackfillClock,
  type BackfillSubagent,
  type BackfillTally,
  emptyTally,
  firstTimedRecordOf,
  resultAgentIdsOf,
  sourceToolUseIdOf,
  TranscriptBackfill,
} from "../claude-code/backfill";
import type { ClaudeCodeContext } from "../claude-code/context";
import { SessionRecorder } from "../claude-code/recorder";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import { readJsonStateFile, writeSensitiveFileAtomic } from "../host/fs";
import { type AdoptedTranscriptCursor, SEAL_SLICE_BYTES } from "./transcript-tailer";

/** A transcript written to more recently than this may still be running. */
export const BACKFILL_ACTIVE_MS = 15 * 60_000;

/**
 * Reading pauses while the WAL holds more unshipped events than this. ADR-161
 * set the bound at 64 MiB. The WAL counts events, not bytes, and the first
 * real import (#4394, 2026-10-02) queued 88,000 events in 1.0 GB, about
 * 12 KiB each, so 64 MiB is about 5,000 events.
 */
export const BACKLOG_PAUSE_EVENTS = 5_000;

/** The most session uuids one `list_tacho_session_heads` call takes. */
export const SESSION_HEADS_BATCH = 500;

/** The longest line the pass reads; a longer one is counted and a gap. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** How many bytes one read takes from a transcript. */
const READ_CHUNK_BYTES = 256 * 1024;

/** How many leading bytes of a transcript fingerprint it, as the tailer's. */
const HEAD_BYTES = 64;

/** How much of a transcript the pass reads to find its first timed record. */
const FIRST_RECORD_PROBE_BYTES = 64 * 1024;

/** How often the cursor file is written while a pass runs. */
const LEDGER_FLUSH_MS = 2_000;

/** How often the pass checks the WAL's backlog and reports progress. */
const CHECK_EVERY_MS = 1_000;

export const BACKFILL_ACTIONS = [
  "backfilled",
  "skipped_local_chain",
  "skipped_server_chain",
  "skipped_already_backfilled",
  "skipped_older_normalizer",
  "skipped_active",
  "skipped_server_unanswered",
  "skipped_empty",
  "failed",
] as const;
export type BackfillAction = (typeof BACKFILL_ACTIONS)[number];

/** What one pass covers. Every filter is optional. */
export interface BackfillRequest {
  /** UTC date, `YYYY-MM-DD`: transcripts whose first timed record is on or after it. */
  since?: string;
  /** UTC date, `YYYY-MM-DD`: transcripts whose first timed record is before it. */
  until?: string;
  /** Project directory names under `~/.claude/projects` to read. */
  projects?: string[];
  /** Project directory names to skip, applied after `projects`. */
  excludeProjects?: string[];
  /** Session ids to read, each with its subagents. */
  sessions?: string[];
  /** Read, seal in memory, and ask the control plane. Write and ship nothing. */
  dryRun?: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PROJECT_NAME = /^[^/\\]{1,255}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The request a client sent, checked, or the reason it is refused. Strings
 * only: a project name that holds a path separator or `..` could reach
 * outside the projects directory.
 */
export function parseBackfillRequest(
  value: unknown,
): { request: BackfillRequest } | { error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { error: "the request must be a JSON object" };
  const input = value as Record<string, unknown>;
  const request: BackfillRequest = {};
  for (const key of ["since", "until"] as const) {
    const date = input[key];
    if (date === undefined) continue;
    if (
      typeof date !== "string" ||
      !DATE.test(date) ||
      Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))
    )
      return { error: `--${key} must be a date written YYYY-MM-DD` };
    request[key] = date;
  }
  if (
    request.since !== undefined &&
    request.until !== undefined &&
    request.until <= request.since
  )
    return { error: "--until must be later than --since" };
  const lists = [
    ["projects", "project", PROJECT_NAME],
    ["excludeProjects", "exclude-project", PROJECT_NAME],
    ["sessions", "session", SESSION_ID],
  ] as const;
  for (const [key, flag, pattern] of lists) {
    const list = input[key];
    if (list === undefined) continue;
    if (
      !Array.isArray(list) ||
      list.length > 1_000 ||
      list.some(
        (item) =>
          typeof item !== "string" ||
          !pattern.test(item) ||
          item === "." ||
          item === "..",
      )
    )
      return { error: `--${flag} names a value this command cannot read` };
    request[key] = [...(list as string[])];
  }
  if (input["dryRun"] !== undefined && typeof input["dryRun"] !== "boolean")
    return { error: "dryRun must be true or false" };
  if (input["dryRun"] === true) request.dryRun = true;
  return { request };
}

/** What the control plane holds for one session (`list_tacho_session_heads`). */
export interface ServerSessionHead {
  session_uuid: string;
  seq_count: number;
  record_basis: "live" | "backfill" | "mixed";
  /** The normalizer version a backfill sealed the session under, when one did. */
  backfill_normalizer: string | null;
}

/** One project directory, as the report lists it. */
export interface BackfillProject {
  slug: string;
  sessions: number;
  subagents: number;
  /** The first timed record of the earliest and latest session, UTC dates. */
  first?: string;
  last?: string;
  included: boolean;
}

/** What a pass did. Counts, directory names, and dates only. */
export interface BackfillReport {
  dry_run: boolean;
  normalizer_version: string;
  /** False while the pass runs, and when it stopped before the end. */
  finished: boolean;
  /** Why the pass stopped before the end, when it did. */
  stopped?: "daemon_stopping" | "cancelled" | "error";
  projects: BackfillProject[];
  sessions: Record<BackfillAction, number>;
  frames: Record<string, number>;
  synthesized: number;
  tokens: Record<string, Record<string, number>>;
  harness_reported_cost: { usd_micros: number; sessions: number };
  records_ignored: Record<string, number>;
  drift: {
    unknown_types: Record<string, number>;
    untested_version_sessions: number;
  };
  errors: {
    unparseable_lines: number;
    refused_lines: number;
    long_lines: number;
    torn_tails: number;
    unreadable_files: number;
  };
  bodies: { mode: string; shipped: number };
}

/** One transcript's entry in the cursor file. */
interface LedgerEntry {
  session_id: string;
  session_uuid: string;
  ino: number;
  /** The file's first bytes, base64, as the tailer fingerprints them. */
  head: string;
  /** The offset after the last whole line read. */
  bytes: number;
  /** The session chain's next seq and the hash it follows. */
  next_seq: number;
  prev_hash: string;
  turn_seq: number;
  normalizer: string;
  /** `partial`: a pass stopped inside the file; `failed`: see `reason`. */
  status: "done" | "partial" | "failed";
  /** Subagents whose transcripts the pass read to the end. */
  subagents: string[];
  reason?: string;
}

interface LedgerFile {
  schema: "tacho.backfill-cursor.v1";
  transcripts: Record<string, LedgerEntry>;
}

/** A failure a later pass does not retry: the chain on disk is not this one. */
const FINAL_FAILURES = new Set(["diverged"]);

/**
 * The cursor file (`TACHO_HOME/agents/<id>/backfill-cursor.json`), held in
 * memory and written atomically at most every `LEDGER_FLUSH_MS` while a pass
 * runs. A write the daemon did not get to is safe to lose: the next pass
 * replays the transcript and the WAL decides what is already sealed.
 */
export class BackfillLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly byUuid = new Map<string, string>();
  private dirty = false;
  private flushedAt = 0;

  constructor(
    private readonly path: string | undefined,
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    if (path === undefined) return;
    const persisted = readJsonStateFile(path, (movedTo) =>
      log(
        movedTo === undefined
          ? "backfill cursor file did not parse and could not be moved aside; starting without it"
          : `backfill cursor file did not parse; moved it to ${movedTo}`,
      ),
    );
    if (!isLedgerFile(persisted)) return;
    for (const [file, entry] of Object.entries(persisted.transcripts)) {
      if (!isLedgerEntry(entry)) continue;
      this.entries.set(file, entry);
      this.byUuid.set(entry.session_uuid, file);
    }
  }

  entry(path: string): LedgerEntry | undefined {
    return this.entries.get(path);
  }

  set(path: string, entry: LedgerEntry): void {
    this.entries.set(path, entry);
    this.byUuid.set(entry.session_uuid, path);
    this.dirty = true;
  }

  /**
   * Where a chain a pass sealed ends, for the registry to continue it when
   * the session resumes live. A failed pass's chain is not continued.
   */
  chainHead(
    sessionUuid: string,
  ): { cursor: ChainCursor; turnSeq: number } | undefined {
    const path = this.byUuid.get(sessionUuid);
    const entry = path === undefined ? undefined : this.entries.get(path);
    if (entry === undefined || entry.status === "failed") return undefined;
    return {
      cursor: {
        seq: entry.next_seq,
        prevHash: entry.prev_hash as ChainCursor["prevHash"],
      },
      turnSeq: entry.turn_seq,
    };
  }

  /** Where a pass stopped reading a transcript, for the tailer. */
  transcriptCursor(
    harnessSessionId: string,
    path: string,
  ): AdoptedTranscriptCursor | undefined {
    const entry = this.entries.get(path);
    if (
      entry === undefined ||
      entry.status === "failed" ||
      entry.session_id !== harnessSessionId
    )
      return undefined;
    return {
      offset: entry.bytes,
      ino: entry.ino,
      head: entry.head,
      subagents: [...entry.subagents],
    };
  }

  /** Write the file if it changed and the last write is old enough, or now. */
  flush(force = false): void {
    if (!this.dirty || this.path === undefined) return;
    if (!force && this.now() - this.flushedAt < LEDGER_FLUSH_MS) return;
    const file: LedgerFile = {
      schema: "tacho.backfill-cursor.v1",
      transcripts: Object.fromEntries(this.entries),
    };
    try {
      writeSensitiveFileAtomic(this.path, `${JSON.stringify(file)}\n`);
      this.dirty = false;
      this.flushedAt = this.now();
    } catch (error) {
      this.log(
        `backfill cursor file not written: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function isLedgerFile(value: unknown): value is LedgerFile {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { schema?: unknown }).schema === "tacho.backfill-cursor.v1" &&
    typeof (value as { transcripts?: unknown }).transcripts === "object" &&
    (value as { transcripts?: unknown }).transcripts !== null
  );
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["session_id"] === "string" &&
    typeof entry["session_uuid"] === "string" &&
    typeof entry["ino"] === "number" &&
    typeof entry["head"] === "string" &&
    typeof entry["bytes"] === "number" &&
    typeof entry["next_seq"] === "number" &&
    typeof entry["prev_hash"] === "string" &&
    typeof entry["turn_seq"] === "number" &&
    typeof entry["normalizer"] === "string" &&
    (entry["status"] === "done" ||
      entry["status"] === "partial" ||
      entry["status"] === "failed") &&
    Array.isArray(entry["subagents"])
  );
}

export interface BackfillDeps {
  /** Where Claude Code keeps its project directories. */
  roots: readonly string[];
  ledger: BackfillLedger;
  now: () => number;
  /** Whether the registry or the tailer holds the session already. */
  heldLocally: (harnessSessionId: string) => boolean;
  /** The chain uuid a Claude Code session id takes on this host. */
  sessionUuidOf: (harnessSessionId: string) => string;
  /**
   * The control plane's heads for these sessions, or undefined when it did
   * not answer. A session it does not hold is absent from the map.
   */
  sessionHeads: (
    sessionUuids: readonly string[],
  ) => Promise<ReadonlyMap<string, ServerSessionHead> | undefined>;
  /** A backfill-mode recorder for the session, on `clock`. */
  recorder: (harnessSessionId: string, clock: BackfillClock) => SessionRecorder;
  /** Run `apply` on the session's hook queue (ADR-231). */
  exclusive: <T>(harnessSessionId: string, apply: () => T) => Promise<T>;
  /** Append to the WAL. Throws when the write fails. */
  record: (events: readonly TachoEvent[], bodies: readonly FrameBody[]) => void;
  /** The WAL's position after the last event it holds for a chain. */
  walTail: (sessionUuid: string) => { seq: number; prevHash: string } | undefined;
  /** Unshipped events in the WAL, for the backlog pause. */
  unshippedEvents: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The workspace's body mode, as the report names it. */
  bodyMode: () => string;
  /** Whether the body mode in force ships this body. */
  bodyShips: (body: FrameBody) => boolean;
  log: (line: string) => void;
  /** Called about once a second with the report so far. */
  progress?: (report: BackfillReport) => void;
  /** Aborted when the daemon stops or the client goes away. */
  signal?: AbortSignal;
  /** The slice size; tests make it small. */
  sliceBytes?: number;
}

/** One transcript a pass found. */
interface Candidate {
  project: string;
  sessionId: string;
  sessionUuid: string;
  path: string;
  ino: number;
  mtimeMs: number;
  firstMs?: number;
  subagents: SubagentFile[];
}

interface SubagentFile {
  agentId: string;
  path: string;
  meta: { agentType?: string; toolUseId?: string };
}

/** One line of a read, or a line too long to take. */
interface SliceLine {
  text?: string;
  offset: number;
}

/** Stop a pass between slices. */
class Stopped extends Error {}

function emptySessions(): Record<BackfillAction, number> {
  return Object.fromEntries(
    BACKFILL_ACTIONS.map((action) => [action, 0]),
  ) as Record<BackfillAction, number>;
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The recorder a pass seals one session with: the daemon's identity, the
 * pass's clock, and no WAL lookup, so the chain starts at genesis and is the
 * same on every pass. The pass itself checks the replay against the WAL.
 */
export function backfillRecorders(
  context: ClaudeCodeContext,
  scope: string,
): (harnessSessionId: string, clock: BackfillClock) => SessionRecorder {
  const { chainTail: _onDisk, now: _wallClock, ...base } = context;
  return (harnessSessionId, clock) =>
    new SessionRecorder({
      context: { ...base, now: clock.now },
      harnessSessionId,
      scope,
      backfill: { normalizerVersion: BACKFILL_NORMALIZER_VERSION },
    });
}

/** Run one pass. Never throws for a single transcript; see `failed`. */
export async function runBackfill(
  request: BackfillRequest,
  deps: BackfillDeps,
): Promise<BackfillReport> {
  const dryRun = request.dryRun === true;
  const tally = emptyTally();
  const sessions = emptySessions();
  let shippedBodies = 0;
  const report = (finished: boolean, stopped?: BackfillReport["stopped"]): BackfillReport => ({
    dry_run: dryRun,
    normalizer_version: BACKFILL_NORMALIZER_VERSION,
    finished,
    ...(stopped !== undefined ? { stopped } : {}),
    projects,
    sessions: { ...sessions },
    frames: { ...tally.frames },
    synthesized: tally.synthesized,
    tokens: structuredClone(tally.tokens),
    harness_reported_cost: {
      usd_micros: tally.harnessReportedCostMicros,
      sessions: tally.sessionsWithCostState,
    },
    records_ignored: { ...tally.recordsIgnored },
    drift: {
      unknown_types: { ...tally.drift.unknownTypes },
      untested_version_sessions: tally.drift.untestedVersionSessions,
    },
    errors: {
      unparseable_lines: tally.errors.unparseableLines,
      refused_lines: tally.errors.refusedLines,
      long_lines: tally.errors.longLines,
      torn_tails: tally.errors.tornTails,
      unreadable_files: tally.errors.unreadableFiles,
    },
    bodies: { mode: deps.bodyMode(), shipped: shippedBodies },
  });
  let projects: BackfillProject[] = [];
  let checkedAt = 0;
  /** Between slices: stop, report progress, and wait out a WAL backlog. */
  const between = async (): Promise<void> => {
    if (deps.signal?.aborted === true) throw new Stopped();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (deps.now() - checkedAt < CHECK_EVERY_MS) return;
    checkedAt = deps.now();
    deps.progress?.(report(false));
    deps.ledger.flush();
    if (dryRun) return;
    while (deps.unshippedEvents() > BACKLOG_PAUSE_EVENTS) {
      if (deps.signal?.aborted === true) throw new Stopped();
      await deps.sleep(CHECK_EVERY_MS);
    }
  };

  try {
    const found = await discover(request, deps, tally);
    projects = found.projects;
    const pending: Candidate[] = [];
    for (const candidate of found.candidates) {
      const local = localAction(candidate, deps);
      if (local !== undefined) sessions[local] += 1;
      else pending.push(candidate);
      if (deps.signal?.aborted === true) throw new Stopped();
    }
    const heads = await askServer(pending, deps);
    for (const candidate of pending) {
      const action = serverAction(candidate, heads, deps.ledger);
      // A real pass starts no chain the control plane could not check. A dry
      // run still reads the session, so its counts say what a pass would
      // seal once the control plane answers.
      const readAnyway = dryRun && action === "skipped_server_unanswered";
      if (action !== undefined) sessions[action] += 1;
      if (action !== undefined && !readAnyway) continue;
      const outcome = await sealTranscript(candidate, deps, dryRun, between);
      addTally(tally, outcome.tally);
      shippedBodies += outcome.bodies;
      if (!readAnyway) sessions[outcome.action] += 1;
      await between();
    }
    deps.ledger.flush(true);
    return report(true);
  } catch (error) {
    deps.ledger.flush(true);
    if (error instanceof Stopped)
      return report(false, deps.signal?.reason === "cancelled" ? "cancelled" : "daemon_stopping");
    deps.log(
      `backfill pass stopped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return report(false, "error");
  }
}

/** The transcripts under the roots, with every directory for the report. */
async function discover(
  request: BackfillRequest,
  deps: BackfillDeps,
  tally: BackfillTally,
): Promise<{ projects: BackfillProject[]; candidates: Candidate[] }> {
  const projects: BackfillProject[] = [];
  const candidates: Candidate[] = [];
  const only = request.projects === undefined ? undefined : new Set(request.projects);
  const skip = new Set(request.excludeProjects ?? []);
  const sessionsWanted =
    request.sessions === undefined ? undefined : new Set(request.sessions);
  const sinceMs =
    request.since === undefined ? undefined : Date.parse(`${request.since}T00:00:00.000Z`);
  const untilMs =
    request.until === undefined ? undefined : Date.parse(`${request.until}T00:00:00.000Z`);
  for (const root of deps.roots) {
    for (const slug of (await listDir(root)).sort()) {
      const dir = join(root, slug);
      if (!(await isDirectory(dir))) continue;
      const included = (only === undefined || only.has(slug)) && !skip.has(slug);
      const names = (await listDir(dir))
        .filter((name) => name.endsWith(".jsonl") && !name.startsWith("agent-"))
        .sort();
      const project: BackfillProject = { slug, sessions: 0, subagents: 0, included };
      projects.push(project);
      let first: number | undefined;
      let last: number | undefined;
      for (const name of names) {
        const sessionId = name.slice(0, -".jsonl".length);
        if (sessionsWanted !== undefined && !sessionsWanted.has(sessionId)) continue;
        const path = join(dir, name);
        project.sessions += 1;
        if (!included) {
          project.subagents += await countSubagents(join(dir, sessionId));
          continue;
        }
        const subagents = await subagentFiles(join(dir, sessionId), tally);
        project.subagents += subagents.length;
        let stat: { ino: number; mtimeMs: number };
        try {
          stat = await fs.stat(path);
        } catch {
          tally.errors.unreadableFiles += 1;
          continue;
        }
        const firstMs = await firstRecordMs(path);
        if (firstMs !== undefined) {
          first = first === undefined ? firstMs : Math.min(first, firstMs);
          last = last === undefined ? firstMs : Math.max(last, firstMs);
        }
        if (sinceMs !== undefined && (firstMs === undefined || firstMs < sinceMs))
          continue;
        if (untilMs !== undefined && (firstMs === undefined || firstMs >= untilMs))
          continue;
        candidates.push({
          project: slug,
          sessionId,
          sessionUuid: deps.sessionUuidOf(sessionId),
          path,
          ino: stat.ino,
          mtimeMs: stat.mtimeMs,
          ...(firstMs !== undefined ? { firstMs } : {}),
          subagents,
        });
      }
      if (first !== undefined) project.first = utcDate(first);
      if (last !== undefined) project.last = utcDate(last);
    }
  }
  // The newest sessions first, so the most recent history is on the Run
  // page soonest. The shipper sends newest first as well (#5068).
  candidates.sort((a, b) => (b.firstMs ?? 0) - (a.firstMs ?? 0));
  return { projects, candidates };
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A session's subagent transcripts: `subagents/agent-<id>.jsonl`, and a
 * workflow's under `subagents/workflows/<id>/`. A workflow's `journal.jsonl`
 * is counted and not read into frames (spec section 2).
 */
async function subagentFiles(
  sessionDir: string,
  tally: BackfillTally,
): Promise<SubagentFile[]> {
  const dir = join(sessionDir, "subagents");
  const out: SubagentFile[] = [];
  const add = async (folder: string, name: string): Promise<void> => {
    const match = /^agent-(.+)\.jsonl$/.exec(name);
    if (match === null) return;
    const agentId = match[1] as string;
    out.push({
      agentId,
      path: join(folder, name),
      meta: await readMeta(join(folder, `agent-${agentId}.meta.json`)),
    });
  };
  for (const name of (await listDir(dir)).sort()) await add(dir, name);
  const workflows = join(dir, "workflows");
  for (const workflow of (await listDir(workflows)).sort()) {
    const folder = join(workflows, workflow);
    for (const name of (await listDir(folder)).sort()) {
      if (name === "journal.jsonl") {
        tally.recordsIgnored["workflow-journal"] =
          (tally.recordsIgnored["workflow-journal"] ?? 0) + 1;
        continue;
      }
      await add(folder, name);
    }
  }
  return out;
}

/** How many subagent transcripts a session wrote, by name alone. */
async function countSubagents(sessionDir: string): Promise<number> {
  const dir = join(sessionDir, "subagents");
  const isAgent = (name: string) => /^agent-.+\.jsonl$/.test(name);
  let count = (await listDir(dir)).filter(isAgent).length;
  for (const workflow of await listDir(join(dir, "workflows")))
    count += (await listDir(join(dir, "workflows", workflow))).filter(isAgent).length;
  return count;
}

/** The two `meta.json` members the subagent join reads. */
async function readMeta(
  path: string,
): Promise<{ agentType?: string; toolUseId?: string }> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
    const agentType = parsed["agentType"];
    const toolUseId = parsed["toolUseId"];
    return {
      ...(typeof agentType === "string" && agentType.length > 0 ? { agentType } : {}),
      ...(typeof toolUseId === "string" && toolUseId.length > 0 ? { toolUseId } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * The instant of a transcript's first timed record, from its first bytes. A
 * small read finds it in most files; a larger one covers a long first line.
 */
async function firstRecordMs(path: string): Promise<number | undefined> {
  for (const length of [8 * 1024, FIRST_RECORD_PROBE_BYTES]) {
    const bytes = await readHead(path, length);
    if (bytes === undefined) return undefined;
    for (const line of bytes.toString("utf8").split("\n")) {
      const found = firstTimedRecordOf(line);
      if (found !== undefined) return found.ms;
    }
    if (bytes.length < length) return undefined;
  }
  return undefined;
}

async function readHead(path: string, length: number): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, "r");
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** The action a transcript takes from local state alone, or undefined. */
function localAction(
  candidate: Candidate,
  deps: BackfillDeps,
): BackfillAction | undefined {
  const entry = deps.ledger.entry(candidate.path);
  if (deps.heldLocally(candidate.sessionId)) return "skipped_local_chain";
  // A chain in the WAL this ledger did not write is a live one the registry
  // lost; the replay would refuse it anyway.
  if (entry === undefined && deps.walTail(candidate.sessionUuid) !== undefined)
    return "skipped_local_chain";
  if (deps.now() - candidate.mtimeMs < BACKFILL_ACTIVE_MS) return "skipped_active";
  if (entry === undefined || entry.ino !== candidate.ino) return undefined;
  if (entry.status === "failed")
    return FINAL_FAILURES.has(entry.reason ?? "") ? "failed" : undefined;
  if (entry.status === "partial") return undefined;
  return entry.normalizer === BACKFILL_NORMALIZER_VERSION
    ? "skipped_already_backfilled"
    : "skipped_older_normalizer";
}

/** Ask the control plane for every pending session, in batches. */
async function askServer(
  pending: readonly Candidate[],
  deps: BackfillDeps,
): Promise<Map<string, ServerSessionHead> | undefined> {
  const heads = new Map<string, ServerSessionHead>();
  for (let index = 0; index < pending.length; index += SESSION_HEADS_BATCH) {
    const batch = pending
      .slice(index, index + SESSION_HEADS_BATCH)
      .map((candidate) => candidate.sessionUuid);
    const answer = await deps.sessionHeads(batch);
    if (answer === undefined) return undefined;
    for (const [uuid, head] of answer) heads.set(uuid, head);
  }
  return heads;
}

/** The action the control plane's answer decides, or undefined to seal. */
function serverAction(
  candidate: Candidate,
  heads: ReadonlyMap<string, ServerSessionHead> | undefined,
  ledger: BackfillLedger,
): BackfillAction | undefined {
  if (heads === undefined) return "skipped_server_unanswered";
  const head = heads.get(candidate.sessionUuid);
  if (head === undefined) return undefined;
  // The live path's chain, or one a live resume continued: the backfill
  // never fills a gap in a witnessed chain.
  if (head.record_basis !== "backfill") return "skipped_server_chain";
  // This host's own pass stopped partway: the replay finishes it.
  const entry = ledger.entry(candidate.path);
  if (entry?.status === "partial" && entry.ino === candidate.ino) return undefined;
  return head.backfill_normalizer === BACKFILL_NORMALIZER_VERSION
    ? "skipped_already_backfilled"
    : "skipped_older_normalizer";
}

/**
 * Read one transcript and its subagents, seal them, and append what the WAL
 * does not hold yet. A dry run seals in memory and appends nothing.
 */
async function sealTranscript(
  candidate: Candidate,
  deps: BackfillDeps,
  dryRun: boolean,
  between: () => Promise<void>,
): Promise<{ action: BackfillAction; tally: BackfillTally; bodies: number }> {
  const clock = new BackfillClock();
  const recorder = deps.recorder(candidate.sessionId, clock);
  const driver = new TranscriptBackfill({
    recorder,
    clock,
    subagents: await subagentLinks(candidate.subagents),
    resultAgentIds:
      candidate.subagents.length === 0
        ? new Map()
        : await resultAgentIds(candidate.path),
  });
  const files = new Map(candidate.subagents.map((file) => [file.agentId, file]));
  const tails = new Map<string, { seq: number; prevHash: string } | null>();
  let bodies = 0;
  const finished: string[] = [];
  /** Drop what the WAL already holds, check where they meet, and append. */
  const emit = (events: readonly TachoEvent[]): void => {
    const sealed = recorder.takeBodies();
    if (dryRun) {
      recorder.trimSealedEvents(0);
      for (const body of sealed) if (deps.bodyShips(body)) bodies += 1;
      return;
    }
    const fresh: TachoEvent[] = [];
    for (const event of events) {
      let tail = tails.get(event.session_uuid);
      if (tail === undefined) {
        tail = deps.walTail(event.session_uuid) ?? null;
        tails.set(event.session_uuid, tail);
      }
      if (tail !== null && event.seq < tail.seq) {
        if (event.seq === tail.seq - 1 && event.hash !== tail.prevHash)
          throw new Diverged(event.session_uuid);
        continue;
      }
      fresh.push(event);
    }
    // The recorder keeps what it sealed for its own checks within a call;
    // across slices that would hold a whole transcript's frames.
    recorder.trimSealedEvents(0);
    if (fresh.length === 0) return;
    const ids = new Set(fresh.map((event) => event.event_id_idem));
    const kept = sealed.filter((body) => ids.has(body.event_id_idem));
    deps.record(fresh, kept);
    for (const body of kept) if (deps.bodyShips(body)) bodies += 1;
  };
  const sliceBytes = deps.sliceBytes ?? SEAL_SLICE_BYTES;
  const feedSubagent = async (agentId: string): Promise<void> => {
    const file = files.get(agentId);
    if (file === undefined) return;
    try {
      const read = await readSlices(file.path, sliceBytes, async (lines) => {
        await deps.exclusive(candidate.sessionId, () => {
          const out: TachoEvent[] = [];
          for (const line of lines)
            out.push(
              ...(line.text === undefined
                ? driver.longLine(line.offset, agentId)
                : driver.subagentLine(agentId, line.text, line.offset)),
            );
          emit(out);
        });
        await between();
      });
      if (read.torn) driver.tally.errors.tornTails += 1;
      finished.push(agentId);
    } catch (error) {
      if (error instanceof Stopped || error instanceof Diverged) throw error;
      driver.tally.errors.unreadableFiles += 1;
    }
  };
  const partial = (bytes: number, status: LedgerEntry["status"], reason?: string): void => {
    if (dryRun) return;
    const cursor = recorder.chainCursor;
    deps.ledger.set(candidate.path, {
      session_id: candidate.sessionId,
      session_uuid: candidate.sessionUuid,
      ino: candidate.ino,
      head: headAt.toString("base64"),
      bytes,
      next_seq: cursor.seq,
      prev_hash: cursor.prevHash,
      turn_seq: recorder.turnCount,
      normalizer: BACKFILL_NORMALIZER_VERSION,
      status,
      subagents: [...finished].sort(),
      ...(reason !== undefined ? { reason } : {}),
    });
  };
  const headAt = (await readHead(candidate.path, HEAD_BYTES)) ?? Buffer.alloc(0);
  let readTo = 0;
  try {
    partial(0, "partial");
    const read = await readSlices(candidate.path, sliceBytes, async (lines) => {
      let index = 0;
      while (index < lines.length) {
        const spawn: string[] = [];
        await deps.exclusive(candidate.sessionId, () => {
          // A hook for this session arrived since the pass began: the live
          // path owns it from here.
          if (deps.heldLocally(candidate.sessionId)) throw new TakenLive();
          const out: TachoEvent[] = [];
          while (index < lines.length && spawn.length === 0) {
            const line = lines[index] as SliceLine;
            index += 1;
            if (line.text === undefined) {
              out.push(...driver.longLine(line.offset));
              continue;
            }
            const sealed = driver.line(line.text, line.offset);
            out.push(...sealed.events);
            spawn.push(...sealed.spawn);
          }
          emit(out);
        });
        for (const agentId of spawn) await feedSubagent(agentId);
      }
      readTo = lines.at(-1)?.next ?? readTo;
      // Where the live path picks up if a hook takes the session now.
      partial(readTo, "partial");
      await between();
    });
    readTo = read.end;
    const flushed = await deps.exclusive(candidate.sessionId, () => {
      const result = driver.finishParent();
      emit(result.events);
      return result.spawn;
    });
    for (const agentId of flushed) await feedSubagent(agentId);
    if (read.torn) {
      // The last line is not whole yet. The session stays open, and a later
      // pass reads on once the line is complete (spec section 8).
      driver.tally.errors.tornTails += 1;
      partial(readTo, "partial");
      return { action: "backfilled", tally: driver.tally, bodies };
    }
    for (const agentId of driver.unspawned()) await feedSubagent(agentId);
    await deps.exclusive(candidate.sessionId, () => emit(driver.end()));
    partial(readTo, "done");
    return {
      action: driver.hasChain ? "backfilled" : "skipped_empty",
      tally: driver.tally,
      bodies,
    };
  } catch (error) {
    if (error instanceof Stopped) throw error;
    if (error instanceof TakenLive) {
      deps.log(`backfill of session ${candidate.sessionId} stopped: a live hook took it`);
      partial(readTo, "partial");
      return { action: "skipped_local_chain", tally: driver.tally, bodies };
    }
    const reason =
      error instanceof Diverged
        ? "diverged"
        : (error as NodeJS.ErrnoException).code !== undefined
          ? "unreadable"
          : "error";
    if (reason === "unreadable") driver.tally.errors.unreadableFiles += 1;
    deps.log(
      `backfill of session ${candidate.sessionId} failed (${reason}): ${error instanceof Error ? error.message : String(error)}`,
    );
    partial(readTo, "failed", reason);
    return { action: "failed", tally: driver.tally, bodies };
  }
}

/** The WAL holds a different chain for this uuid than the replay seals. */
class Diverged extends Error {
  constructor(sessionUuid: string) {
    super(`the WAL's chain for ${sessionUuid} differs from the transcript's`);
  }
}

/** A live hook registered the session while the pass read it. */
class TakenLive extends Error {}

/** The join facts of each subagent: its `meta.json` and its own records. */
async function subagentLinks(
  files: readonly SubagentFile[],
): Promise<BackfillSubagent[]> {
  const out: BackfillSubagent[] = [];
  for (const file of files) {
    let source: string | undefined;
    const head = await readHead(file.path, FIRST_RECORD_PROBE_BYTES);
    for (const line of head?.toString("utf8").split("\n") ?? []) {
      source = sourceToolUseIdOf(line);
      if (source !== undefined) break;
    }
    out.push({
      agentId: file.agentId,
      ...(file.meta.agentType !== undefined ? { agentType: file.meta.agentType } : {}),
      ...(file.meta.toolUseId !== undefined ? { metaToolUseId: file.meta.toolUseId } : {}),
      ...(source !== undefined ? { sourceToolUseId: source } : {}),
    });
  }
  return out;
}

/**
 * The subagent each spawning call's result names, read from the whole parent
 * transcript before the pass, because the result comes after the call.
 */
async function resultAgentIds(path: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    await readSlices(path, SEAL_SLICE_BYTES, async (lines) => {
      for (const line of lines) if (line.text !== undefined) resultAgentIdsOf(line.text, out);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  } catch {
    // The pass reads the file again and reports it unreadable there.
  }
  return out;
}

/**
 * Read a file as whole lines, `sliceBytes` at a time, through `onSlice`. A
 * line longer than `MAX_LINE_BYTES` comes through with no text. Answers the
 * offset after the last whole line and whether bytes followed it that no
 * newline ended (a torn tail, left unread).
 */
async function readSlices(
  path: string,
  sliceBytes: number,
  onSlice: (lines: Array<SliceLine & { next: number }>) => Promise<void>,
): Promise<{ end: number; torn: boolean }> {
  const handle = await fs.open(path, "r");
  try {
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let position = 0;
    let lineStart = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let skipping = false;
    let slice: Array<SliceLine & { next: number }> = [];
    let sliceSize = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline === -1) break;
        const next = position + newline + 1;
        if (skipping) slice.push({ offset: lineStart, next });
        else {
          const part = chunk.subarray(start, newline);
          const text =
            pendingBytes === 0
              ? part.toString("utf8")
              : Buffer.concat([...pending, part]).toString("utf8");
          slice.push({ text, offset: lineStart, next });
        }
        sliceSize += next - lineStart;
        pending = [];
        pendingBytes = 0;
        skipping = false;
        lineStart = next;
        start = newline + 1;
        if (sliceSize >= sliceBytes) {
          const full = slice;
          slice = [];
          sliceSize = 0;
          await onSlice(full);
        }
      }
      if (start < bytesRead && !skipping) {
        pending.push(Buffer.from(chunk.subarray(start)));
        pendingBytes += bytesRead - start;
        if (pendingBytes > MAX_LINE_BYTES) {
          skipping = true;
          pending = [];
          pendingBytes = 0;
        }
      }
      position += bytesRead;
    }
    if (slice.length > 0) await onSlice(slice);
    return { end: lineStart, torn: position > lineStart };
  } finally {
    await handle.close();
  }
}
