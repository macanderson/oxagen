/**
 * The session registry (spec plan PR 3): one recorder per live agent
 * session, keyed by the agent and the harness session id, with the operator
 * control state a command can set (pause, cancel, message) and the process
 * facts the detector and the kill path need. Persists to `daemon.json` so a
 * daemon restart continues every chain instead of forking it.
 *
 * It also keeps the agent roster: one entry per kind of agent this host has
 * run (`claude-code`, `codex`, `cursor`, `stella`, or a named custom agent), with when
 * it was first and last seen and how many sessions it opened. The roster
 * outlives the sessions it counted — `forgetSealed` drops sealed sessions,
 * never roster entries — so the desktop app can show every agent the host
 * has run, not only those with a live session.
 */
import type { ChainCursor } from "../chain";
import type { ClaudeCodeContext } from "../claude-code/context";
import { type RecorderState, SessionRecorder } from "../claude-code/recorder";
import { isSha256Digest } from "../digest";
import type { TachoEvent, TachoRuntime } from "../envelope";
import { toProtocolTimestamp } from "../timestamp";
import {
  type CommandAcknowledgement,
  isWrappedHarness,
  TACHO_HARNESS_LABELS,
  type TachoDeliveryMode,
  type TachoHarness,
  type WrappedHarness,
} from "../wire";

/**
 * The recorder context for a session's harness. The daemon's context is
 * Claude Code's; a Codex or Stella session keeps every other fact and
 * relabels the agent with its own runtime. `runtime` is the control plane's
 * checked enum (`TACHO_RUNTIMES`), so every harness this map admits must
 * also be a member there: the fleet page filters on `runtime`, and a
 * harness that had to borrow `custom` could not be told apart from a custom
 * agent.
 */
/**
 * Only *wrapped* harnesses appear here. A connected one (ADR-078) never opens
 * a session: it has no hook, so nothing marks a session's start or end, and
 * its gateway calls are sealed on the daemon's own chain instead. Giving it a
 * runtime would invite a caller to open a chain for a session that does not
 * exist.
 */
const RUNTIME_FOR_HARNESS: Record<WrappedHarness, TachoRuntime> = {
  "claude-code": "claude-code",
  codex: "codex",
  cursor: "cursor",
  stella: "stella",
};

/**
 * A custom agent (`tacho hook --agent <name>`) is `runtime: "custom"` with
 * its name as the harness, and wins over `harness`: the name is the more
 * specific claim.
 */
export function contextForHarness(
  context: ClaudeCodeContext,
  harness: TachoHarness | undefined,
  customAgent?: string,
): ClaudeCodeContext {
  if (customAgent !== undefined) {
    return {
      ...context,
      agent: { ...context.agent, harness: customAgent, runtime: "custom" },
    };
  }
  if (harness === undefined || harness === "claude-code") return context;
  // A connected harness has no session to label: its gateway calls are sealed
  // on the daemon's chain, never on one of these. Reaching here with one means
  // a caller opened a session for it, which is a bug, so the context is left
  // as the daemon's rather than inventing a runtime for it.
  if (!isWrappedHarness(harness)) return context;
  return {
    ...context,
    agent: { ...context.agent, harness, runtime: RUNTIME_FOR_HARNESS[harness] },
  };
}

/**
 * Prompt content an operator queued for the next boundary: a `message`, or a
 * `steer` with the mode the control plane resolved (spec section 7.3; both
 * modes are recorded on the frame that carries it). `expiresAt` is the row's
 * deadline; the boundary that would inject the item checks it first, so an
 * item the control plane reads as `expired` is never injected.
 */
export interface QueuedPrompt {
  id: string;
  text: string;
  command: "message" | "steer";
  requestedMode: TachoDeliveryMode | null;
  deliveryMode: TachoDeliveryMode | null;
  degradedReason: string | null;
  expiresAt: string | null;
  /** When the operator issued it. Absent in files written before the field. */
  issuedAt?: string;
  /**
   * The model proxy cut an in-flight call to deliver this sooner (a steer
   * delivered as `interrupt` on a session whose model traffic is routed).
   */
  interrupted?: boolean;
}

/** The daemon's own chain (`tachod-<ulid>`) is host bookkeeping, not an agent. */
export function isInternalSession(harnessSessionId: string): boolean {
  return harnessSessionId.startsWith("tachod-");
}

export interface SessionControl {
  paused: string | null;
  cancelled: string | null;
  /** Operator prompt content to inject at the next boundary. */
  messages: QueuedPrompt[];
}

export interface SessionFacts {
  transcriptPath?: string;
  cwd?: string;
  pid?: number;
  /** Which harness runs the session; fixed at first sight, Claude Code by default. */
  harness?: TachoHarness;
  /** A custom agent's name (`--agent`); fixed at first sight. */
  customAgent?: string;
  /**
   * The newest hook event the session sent. Stella has no SessionEnd, so a
   * chain whose process is gone after a `Stop` ended cleanly; without a
   * `Stop` it did not. Any later hook replaces it, so the sweep reads the
   * recorder's turn first and this only for a session with no turn on record.
   */
  lastHookEvent?: string;
  /**
   * The commit this session was first observed at in its current worktree,
   * and the ref every later reconciliation measures from.
   *
   * Without it a reconciliation compares the worktree with the current
   * `HEAD`, which answers what is uncommitted now rather than what this
   * session changed, so an agent that committed its work before the
   * end-of-turn `Stop` left a clean tree and recorded none of it.
   *
   * Set on the first git read for the session in a given repository, which
   * is the earliest this daemon knows that repository at all. Bound to the
   * repository: when `ensure` sees a new `cwd` this is cleared, and the next
   * read puts back the entry `baselines` holds for the repository the new
   * directory is in, or captures a new one (see `rememberBaseline`).
   * Persisted through `state` / `restore` so a daemon restart does not lose
   * it mid-session.
   *
   * A session that commits before that first read measures from after the
   * commit; that is a smaller window than measuring from `HEAD` every time,
   * and it is the honest limit of a baseline nobody recorded at the start.
   */
  baselineCommit?: string;
  /**
   * The baseline of every repository this session has been read in, keyed
   * by repository root and bounded to `MAX_SESSION_BASELINES`, the least
   * recently read dropped first. `baselineCommit` is the entry for the
   * repository `cwd` is in now. A `cd` inside one repository keeps its
   * entry, and so does a move to another repository and back.
   */
  baselines?: Record<string, string>;
  /**
   * The sweep sealed this chain because it went quiet, not because its
   * process ended or it sent `SessionEnd`. That is a guess, and the next hook
   * the session sends proves it wrong, so that hook reopens the chain.
   */
  closedIdle?: boolean;
}

export interface SessionRecord extends SessionFacts {
  harnessSessionId: string;
  recorder: SessionRecorder;
  control: SessionControl;
  startedAt: string;
  lastSeenAt: string;
  /** True once `agent_stop` sealed the chain. */
  sealed: boolean;
  /**
   * True while a `SessionEnd` terminal has been computed but has not yet
   * reached the WAL. `sealed` reports `false` for this window (the chain is
   * not durably closed), but the record must still refuse new frames: a
   * concurrent write here would seal a sequence number after the terminal
   * event's, and a later WAL failure that discards the terminal would leave
   * the retry appending behind a chain that has already moved on. Every
   * writer that gates on `sealed` gates on this too. Not persisted to
   * `state.json` — it is derived on load from `pending-session-ends.json`,
   * which is the durable record of "this session has a terminal pending".
   */
  pendingTerminal?: boolean;
  /** The chain seq the last checkpoint covered. */
  lastCheckpointSeq: number;
  /** The session never sent a hook; only OTel or a transcript showed it. */
  ambient: boolean;
  /**
   * Open tool calls whose harness issues no tool-use id of its own (Stella),
   * as `derived id -> the id this invocation was given`. See
   * `invocationToolUseId` in the hook handler.
   */
  toolUseIds: Record<string, string>;
  /**
   * The most recent `hook_id`s this session recorded, oldest first, bounded
   * to `HOOK_ID_LEDGER_CAPACITY`. `tacho-hook` generates one when it reads
   * stdin and sends it on both the live request and the spool file it falls
   * back to when that request times out on the client's own side. A client
   * timeout does not mean the daemon never got the hook — only that this
   * process stopped waiting for the answer — so the same hook can arrive
   * twice: once live, once as a later spool replay. See `sawHookId` and
   * `rememberHookId`.
   */
  recentHookIds: string[];
}

export interface PersistedSession extends SessionFacts {
  harnessSessionId: string;
  recorder: RecorderState;
  control: Omit<SessionControl, "messages"> & {
    messages: Array<Pick<QueuedPrompt, "id" | "text"> & Partial<QueuedPrompt>>;
  };
  startedAt: string;
  lastSeenAt: string;
  sealed: boolean;
  lastCheckpointSeq: number;
  ambient: boolean;
  /** Absent in files written before derived tool-use ids were numbered. */
  toolUseIds?: Record<string, string>;
  /** Absent in files written before the hook-id replay ledger existed. */
  recentHookIds?: string[];
}

/** One kind of agent this host has run. */
export interface AgentRosterEntry {
  /** `${runtime}:${harness}`, e.g. `stella:stella` or `custom:reviewer`. */
  key: string;
  runtime: TachoRuntime;
  harness: string;
  /** "Claude Code", "Codex", "Stella", or the custom agent's name. */
  label: string;
  first_seen_at: string;
  last_seen_at: string;
  sessions_total: number;
}

export interface AgentStatus extends AgentRosterEntry {
  /** Sessions of this agent whose chain is not sealed. */
  sessions_live: number;
}

export interface RegistryState {
  schema: "tacho.daemon-state.v1";
  sessions: PersistedSession[];
  /** Absent in files written before the roster existed. */
  agents?: AgentRosterEntry[];
  /** Absent in files written before forgotten chains kept a tombstone. */
  tombstones?: ChainTombstone[];
}

/**
 * Where a forgotten session's chain stopped. `forgetSealed` drops a sealed
 * session a week after it was last seen, but the harness still holds its
 * transcript and can resume it under the same session id. A new recorder
 * for that id derives the same session uuid and would start again at
 * sequence 0, forking a chain the WAL already holds. The tombstone is what
 * lets it continue instead.
 */
export interface ChainTombstone {
  /** `sessionMapKey` of the forgotten record. */
  key: string;
  sessionUuid: string;
  cursor: ChainCursor;
  turnSeq: number;
  forgottenAt: string;
}

/**
 * How long a tombstone outlives the session it stands for. Claude Code
 * deletes a transcript thirty days after its last use by default, and a
 * session with no transcript cannot be resumed.
 */
export const TOMBSTONE_RETAIN_MS = 30 * 24 * 60 * 60_000;

/** The most tombstones kept; the oldest is dropped first. */
export const MAX_TOMBSTONES = 512;

/**
 * How long a session with a pid may go without a single event before the
 * sweep closes it anyway. The OS hands a freed pid to the next process it
 * starts, so a pid that still answers is not proof the harness is running.
 */
export const STALE_PID_SESSION_MS = 24 * 60 * 60_000;

/** The detail an operator reads on a message its session never reached. */
export const EXPIRED_ON_SEAL_DETAIL = "session ended before a boundary";

/** The most such acknowledgements held for the daemon to send. */
const MAX_EXPIRED_ON_SEAL = 256;

/**
 * The daemon-state file as a `RegistryState`, or `undefined` if it is not one.
 *
 * The daemon used to cast the parsed JSON straight to this type. A cast is an
 * assertion that the shape is right, and this is the one place where the shape
 * is known to be wrong: the file on disk was written by whichever build was
 * running before the upgrade, which is precisely why a legacy
 * `anthropic.user_email` survived #3072's fix (`SessionRecorder.restore` now
 * scrubs it, and this stops the cast that let an arbitrary object reach it).
 *
 * Deliberately shallow and forgiving about members it does not know. Rejecting
 * a state file loses a live session's chain cursor, which is worse than the
 * unknown member — so this validates the envelope and hands the rest to
 * `restore`, which sanitizes what it reads. Over-accepting structure is
 * recoverable; letting the address through is not.
 */
export function parseRegistryState(value: unknown): RegistryState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<RegistryState>;
  if (candidate.schema !== "tacho.daemon-state.v1") return undefined;
  if (!Array.isArray(candidate.sessions)) return undefined;
  if (candidate.agents !== undefined && !Array.isArray(candidate.agents))
    return undefined;
  return candidate as RegistryState;
}

export interface RegistryOptions {
  context: ClaudeCodeContext;
  scope: string;
  now: () => number;
}

/**
 * The map key for one harness session under one agent. Two agents can hand
 * out the same raw `harnessSessionId`; this qualifies it so their records
 * (and anything keyed the same way, like a transcript cursor) never collide.
 * The format is `${agent.key} ${harnessSessionId}`, matching `agentOf`.
 */
export function sessionMapKey(
  harnessSessionId: string,
  facts: Pick<SessionFacts, "harness" | "customAgent"> = {},
): string {
  if (facts.customAgent !== undefined) {
    return `custom:${facts.customAgent} ${harnessSessionId}`;
  }
  const named = facts.harness ?? "claude-code";
  const harness: WrappedHarness = isWrappedHarness(named)
    ? named
    : "claude-code";
  return `${RUNTIME_FOR_HARNESS[harness]}:${harness} ${harnessSessionId}`;
}

export class SessionRegistry {
  private readonly options: RegistryOptions;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly roster = new Map<string, AgentRosterEntry>();
  /** Forgotten chains by map key, oldest first; see `ChainTombstone`. */
  private readonly tombstones = new Map<string, ChainTombstone>();
  /**
   * Acknowledgements for queued messages whose session sealed before a
   * boundary delivered them, waiting for the daemon to send them.
   */
  private readonly expiredOnSeal: CommandAcknowledgement[] = [];

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  private ts(): string {
    return toProtocolTimestamp(this.options.now());
  }

  /**
   * The record for a harness session id, whoever owns it: the live one
   * first, then the most recently seen. Two agents can hand out the same id,
   * so a caller that knows which agent it is goes through `ensure`, which
   * never crosses from one agent's record to another's.
   */
  get(harnessSessionId: string): SessionRecord | undefined {
    let best: SessionRecord | undefined;
    for (const record of this.sessions.values()) {
      if (record.harnessSessionId !== harnessSessionId) continue;
      if (best === undefined || preferRecord(record, best)) best = record;
    }
    return best;
  }

  byUuid(sessionUuid: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.recorder.sessionUuid === sessionUuid) return record;
      if (record.recorder.rootSessionUuid === sessionUuid) return record;
      for (const child of record.recorder.openChildren.values()) {
        if (child.sessionUuid === sessionUuid) return record;
      }
    }
    return undefined;
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  live(): SessionRecord[] {
    return this.list().filter((record) => !record.sealed);
  }

  /** Which agent a session belongs to: runtime, harness, and the label a person reads. */
  agentOf(record: SessionFacts): {
    key: string;
    runtime: TachoRuntime;
    harness: string;
    label: string;
  } {
    if (record.customAgent !== undefined) {
      return {
        key: `custom:${record.customAgent}`,
        runtime: "custom",
        harness: record.customAgent,
        label: record.customAgent,
      };
    }
    const named = record.harness ?? "claude-code";
    const harness: WrappedHarness = isWrappedHarness(named)
      ? named
      : "claude-code";
    const runtime = RUNTIME_FOR_HARNESS[harness];
    return {
      key: `${runtime}:${harness}`,
      runtime,
      harness,
      label: TACHO_HARNESS_LABELS[harness],
    };
  }

  private noteAgent(record: SessionRecord, created: boolean): void {
    if (isInternalSession(record.harnessSessionId)) return;
    const agent = this.agentOf(record);
    const now = record.lastSeenAt;
    const entry = this.roster.get(agent.key);
    if (entry === undefined) {
      this.roster.set(agent.key, {
        ...agent,
        first_seen_at: now,
        last_seen_at: now,
        sessions_total: created ? 1 : 0,
      });
      return;
    }
    entry.last_seen_at = now;
    if (created) entry.sessions_total += 1;
  }

  /** Every agent this host has run, with its live session count. */
  agents(): AgentStatus[] {
    const live = new Map<string, number>();
    for (const record of this.live()) {
      if (isInternalSession(record.harnessSessionId)) continue;
      const key = this.agentOf(record).key;
      live.set(key, (live.get(key) ?? 0) + 1);
    }
    return [...this.roster.values()].map((entry) => ({
      ...entry,
      sessions_live: live.get(entry.key) ?? 0,
    }));
  }

  /**
   * The map key. A harness session id is unique only within the agent that
   * issued it: a custom agent whose harness hands out an id another agent is
   * already using must not land on that agent's recorder, or two runs share
   * one hash chain and one roster label. `harnessSessionId` stays the raw id
   * the harness gave, and that is what every payload reports.
   */
  private key(harnessSessionId: string, facts: SessionFacts): string {
    return sessionMapKey(harnessSessionId, facts);
  }

  /**
   * A record opened before any agent named itself (OTel or the transcript
   * detector saw the session first) belongs to the agent that names itself
   * first: it is the same session, and adopting it keeps one chain rather
   * than forking it. The record takes the agent's identity with it — the
   * facts, the roster entry `agentOf` derives from them, the key it persists
   * under, and the recorder's own agent labels — so nothing downstream keeps
   * calling it Claude Code.
   *
   * A custom agent cannot adopt: its chain uuid is seeded from the agent name
   * as well as the id, so taking over an unclaimed chain would have to
   * rename it mid-chain. It opens its own record instead, and the unclaimed
   * one closes on the next sweep.
   */
  private adopt(
    harnessSessionId: string,
    facts: SessionFacts,
  ): SessionRecord | undefined {
    if (facts.customAgent !== undefined) return undefined;
    const unclaimed = this.key(harnessSessionId, {});
    const record = this.sessions.get(unclaimed);
    if (record === undefined || record.sealed) return undefined;
    if (record.harness !== undefined || record.customAgent !== undefined)
      return undefined;
    this.sessions.delete(unclaimed);
    if (facts.harness !== undefined) record.harness = facts.harness;
    record.recorder.relabel(
      contextForHarness(this.options.context, facts.harness, undefined),
    );
    this.sessions.set(this.key(harnessSessionId, facts), record);
    if (!isInternalSession(harnessSessionId)) {
      // The session was counted against Claude Code when it opened
      // unclaimed; it was this agent's session all along. An entry left with
      // nothing to its name is dropped, or the roster would list an agent
      // this host never ran.
      const openerKey = this.agentOf({}).key;
      const opener = this.roster.get(openerKey);
      if (opener !== undefined) {
        opener.sessions_total = Math.max(0, opener.sessions_total - 1);
        if (
          opener.sessions_total === 0 &&
          !this.list().some((other) => this.agentOf(other).key === openerKey)
        )
          this.roster.delete(openerKey);
      }
      this.noteAgent(record, true);
    }
    return record;
  }

  /** Find or open the record for a harness session, absorbing new facts. */
  ensure(
    harnessSessionId: string,
    facts: SessionFacts & { ambient?: boolean } = {},
  ): { record: SessionRecord; created: boolean } {
    const now = this.ts();
    // A caller that names no agent (OTel, the transcript detector) joins
    // whichever agent already owns the id; a caller that names one only ever
    // matches its own agent's record, or adopts one nobody has claimed.
    const named =
      facts.harness !== undefined || facts.customAgent !== undefined;
    const existing = named
      ? (this.sessions.get(this.key(harnessSessionId, facts)) ??
        this.adopt(harnessSessionId, facts))
      : this.get(harnessSessionId);
    if (existing) {
      if (reopens(existing, facts)) this.reopen(existing);
      if (facts.transcriptPath !== undefined)
        existing.transcriptPath = facts.transcriptPath;
      if (facts.cwd !== undefined) {
        // The baseline may be a commit in another repository. Keeping it
        // after a move makes reconciliation diff against a sha that may
        // not exist here, fall back to the new HEAD, and drop work the
        // session already committed in the new tree. `baselines` still
        // holds it by repository, and the next read puts it back when the
        // new directory is in the same one.
        if (existing.cwd !== undefined && facts.cwd !== existing.cwd) {
          delete existing.baselineCommit;
        }
        existing.cwd = facts.cwd;
      }
      if (facts.pid !== undefined) existing.pid = facts.pid;
      if (facts.lastHookEvent !== undefined)
        existing.lastHookEvent = facts.lastHookEvent;
      if (facts.baselineCommit !== undefined)
        existing.baselineCommit = facts.baselineCommit;
      if (facts.ambient === false) existing.ambient = false;
      existing.lastSeenAt = now;
      this.noteAgent(existing, false);
      return { record: existing, created: false };
    }
    const record: SessionRecord = {
      harnessSessionId,
      recorder: this.openRecorder(harnessSessionId, facts),
      control: { paused: null, cancelled: null, messages: [] },
      startedAt: now,
      lastSeenAt: now,
      sealed: false,
      lastCheckpointSeq: -1,
      ambient: facts.ambient ?? false,
      toolUseIds: {},
      recentHookIds: [],
      ...optionalFacts(facts),
    };
    this.sessions.set(this.key(harnessSessionId, facts), record);
    this.noteAgent(record, true);
    return { record, created: true };
  }

  /**
   * The recorder for a session this registry does not hold. A session it
   * forgot continues its chain from the tombstone, but only when a new
   * recorder derives the same uuid: that is proof it is the same chain, and
   * anything else (a legacy uuid, a host enrolled again) opens its own.
   */
  private openRecorder(
    harnessSessionId: string,
    facts: SessionFacts,
  ): SessionRecorder {
    const context = contextForHarness(
      this.options.context,
      facts.harness,
      facts.customAgent,
    );
    const options = {
      context,
      harnessSessionId,
      scope: this.options.scope,
      ...(facts.customAgent === undefined
        ? {}
        : { customAgent: facts.customAgent }),
    };
    const recorder = new SessionRecorder(options);
    const key = this.key(harnessSessionId, facts);
    const tombstone = this.tombstones.get(key);
    if (tombstone === undefined) return recorder;
    this.tombstones.delete(key);
    if (tombstone.sessionUuid !== recorder.sessionUuid) return recorder;
    return new SessionRecorder({
      ...options,
      restore: {
        sessionUuid: tombstone.sessionUuid,
        cursor: { ...tombstone.cursor },
        turnSeq: tombstone.turnSeq,
        turnOpen: false,
        // The chain opened long ago, so the next SessionStart is sealed as
        // the resume it is.
        started: true,
        stopped: false,
        context: {},
        host: { ...context.host },
        anthropic: {},
        totals: {},
        children: {},
      },
    });
  }

  /**
   * Let a sealed chain take frames again at the cursor it closed on. The
   * recorder is told too: `finalize` seals `agent_stop` only on a chain it
   * thinks is still running, so a session that resumed and then crashed
   * would otherwise close with no terminal frame.
   */
  private reopen(record: SessionRecord): void {
    record.sealed = false;
    delete record.closedIdle;
    // `SessionRecorder` has no reopen of its own. A rollback to a mark taken
    // this instant undoes nothing, and it sets the one flag it is handed.
    record.recorder.rollbackChain({
      ...record.recorder.markChain(),
      stopped: false,
    });
  }

  /**
   * Seal the record, and hand every message still queued on it to
   * `takeExpiredOnSeal`: no boundary will come to deliver it, and a command
   * left `received` reads to the operator as one still on its way.
   */
  private close(record: SessionRecord): void {
    record.sealed = true;
    for (const message of record.control.messages.splice(0)) {
      if (this.expiredOnSeal.some((ack) => ack.command_id === message.id))
        continue;
      this.expiredOnSeal.push({
        command_id: message.id,
        status: "expired",
        session_uuid: record.recorder.sessionUuid,
        detail: EXPIRED_ON_SEAL_DETAIL,
      });
    }
    // Bounded for a daemon that never drains it.
    const over = this.expiredOnSeal.length - MAX_EXPIRED_ON_SEAL;
    if (over > 0) this.expiredOnSeal.splice(0, over);
  }

  /**
   * The `expired` acknowledgements for messages whose session sealed before
   * a boundary delivered them, drained. The daemon sends them with the rest.
   */
  takeExpiredOnSeal(): CommandAcknowledgement[] {
    return this.expiredOnSeal.splice(0);
  }

  touch(harnessSessionId: string): void {
    const record = this.get(harnessSessionId);
    if (record) {
      record.lastSeenAt = this.ts();
      this.noteAgent(record, false);
    }
  }

  /**
   * Mark a chain sealed after `agent_stop` landed on it. A caller holding the
   * record passes it: a session id alone cannot tell two agents' chains apart.
   */
  seal(session: string | SessionRecord): void {
    const record = typeof session === "string" ? this.get(session) : session;
    if (record) this.close(record);
  }

  /**
   * Forget sealed sessions older than `retainMs`, and report the harness
   * session ids dropped. The roster keeps them counted, and a tombstone keeps
   * where each chain stopped, so a resume after this continues it.
   */
  forgetSealed(retainMs: number): string[] {
    const now = this.options.now();
    const cutoff = now - retainMs;
    const removed: string[] = [];
    for (const [key, record] of this.sessions) {
      if (record.sealed && Date.parse(record.lastSeenAt) < cutoff) {
        this.sessions.delete(key);
        removed.push(record.harnessSessionId);
        const cursor = record.recorder.chainCursor;
        if (!isInternalSession(record.harnessSessionId) && cursor.seq > 0) {
          this.tombstones.delete(key);
          this.tombstones.set(key, {
            key,
            sessionUuid: record.recorder.sessionUuid,
            cursor: { ...cursor },
            turnSeq: record.recorder.state().turnSeq,
            forgottenAt: toProtocolTimestamp(now),
          });
        }
      }
    }
    for (const [key, tombstone] of this.tombstones) {
      if (
        this.tombstones.size > MAX_TOMBSTONES ||
        Date.parse(tombstone.forgottenAt) < now - TOMBSTONE_RETAIN_MS
      )
        this.tombstones.delete(key);
    }
    return removed;
  }

  /**
   * Close chains whose process is gone, or that went quiet: past `idleMs`
   * with no pid known, past `staleMs` with one (a pid can be reused, so it
   * alone cannot keep a chain open). Returns the sealing events. A session
   * whose process is gone with no turn open finished its last turn and
   * exited: that is how Stella, which has no SessionEnd, ends every session,
   * so it closes as `completed`. Anything else closes as `crashed`,
   * including a session that only ever showed up through OTel or a
   * transcript: the harness never told us it ended.
   */
  sweep(
    isAlive: (pid: number) => boolean,
    idleMs: number,
    deferSeal: (session: SessionRecord) => boolean = () => false,
    staleMs: number = STALE_PID_SESSION_MS,
  ): TachoEvent[] {
    const out: TachoEvent[] = [];
    const now = this.options.now();
    for (const record of this.sessions.values()) {
      if (record.sealed || deferSeal(record)) continue;
      const gone = record.pid !== undefined ? !isAlive(record.pid) : false;
      const quiet = now - Date.parse(record.lastSeenAt);
      // The daemon's own chain is exempt: its pid is this process.
      const idle =
        record.pid === undefined
          ? quiet > idleMs
          : quiet > staleMs && !isInternalSession(record.harnessSessionId);
      if (!gone && !idle) continue;
      if (!gone) record.closedIdle = true;
      if (!record.recorder.hasStarted) {
        this.close(record);
        continue;
      }
      // The recorder's turn, not the newest hook: a Notification after
      // `Stop` replaced it, and a clean exit read as a crash. A session with
      // no turn on record still needs the `Stop` to count as finished.
      const turn = record.recorder.state();
      const outcome =
        gone &&
        !turn.turnOpen &&
        (turn.turnSeq > 0 || record.lastHookEvent === "Stop")
          ? "completed"
          : "crashed";
      out.push(...record.recorder.finalize(outcome, this.ts()));
      this.close(record);
    }
    return out;
  }

  state(): RegistryState {
    return {
      schema: "tacho.daemon-state.v1",
      sessions: this.list().map((record) => ({
        harnessSessionId: record.harnessSessionId,
        recorder: record.recorder.state(),
        control: {
          paused: record.control.paused,
          cancelled: record.control.cancelled,
          messages: [...record.control.messages],
        },
        startedAt: record.startedAt,
        lastSeenAt: record.lastSeenAt,
        sealed: record.sealed,
        lastCheckpointSeq: record.lastCheckpointSeq,
        ambient: record.ambient,
        ...(Object.keys(record.toolUseIds).length > 0
          ? { toolUseIds: { ...record.toolUseIds } }
          : {}),
        ...(record.recentHookIds.length > 0
          ? { recentHookIds: [...record.recentHookIds] }
          : {}),
        ...optionalFacts(record),
      })),
      agents: [...this.roster.values()].map((entry) => ({ ...entry })),
      ...(this.tombstones.size > 0
        ? { tombstones: [...this.tombstones.values()].map(copyTombstone) }
        : {}),
    };
  }

  restore(state: RegistryState): void {
    for (const persisted of state.sessions) {
      this.sessions.set(this.key(persisted.harnessSessionId, persisted), {
        harnessSessionId: persisted.harnessSessionId,
        recorder: new SessionRecorder({
          context: contextForHarness(
            this.options.context,
            persisted.harness,
            persisted.customAgent,
          ),
          harnessSessionId: persisted.harnessSessionId,
          scope: this.options.scope,
          ...(persisted.customAgent === undefined
            ? {}
            : { customAgent: persisted.customAgent }),
          restore: persisted.recorder,
        }),
        control: {
          paused: persisted.control.paused,
          cancelled: persisted.control.cancelled,
          // A state file written before steer carried `{ id, text }` only:
          // a queued message with no mode and no deadline recorded.
          messages: persisted.control.messages.map((m) => ({
            command: "message",
            requestedMode: null,
            deliveryMode: null,
            degradedReason: null,
            expiresAt: null,
            ...m,
          })),
        },
        startedAt: persisted.startedAt,
        lastSeenAt: persisted.lastSeenAt,
        sealed: persisted.sealed,
        lastCheckpointSeq: persisted.lastCheckpointSeq,
        ambient: persisted.ambient,
        toolUseIds: { ...persisted.toolUseIds },
        recentHookIds: [...(persisted.recentHookIds ?? [])],
        ...optionalFacts(persisted),
      });
    }
    for (const entry of state.agents ?? []) {
      this.roster.set(entry.key, { ...entry });
    }
    // A tombstone whose session is held again is spent. One that does not
    // parse is dropped: continuing a chain from a bad cursor forks it too.
    for (const tombstone of state.tombstones ?? []) {
      if (!isTombstone(tombstone) || this.sessions.has(tombstone.key)) continue;
      this.tombstones.set(tombstone.key, copyTombstone(tombstone));
    }
  }
}

/**
 * The most recent hook ids one session's replay-dedup ledger keeps. A
 * client's fallback spool never queues faster than a person or an agent
 * drives hooks, so a few dozen is generous room for a spool replay to still
 * find its live sighting.
 */
export const HOOK_ID_LEDGER_CAPACITY = 64;

/**
 * Whether this session's ledger already holds this hook id — a client-side
 * timeout followed by a spool replay of the hook the daemon already
 * processed live. See `SessionRecord.recentHookIds`.
 */
export function sawHookId(
  record: Pick<SessionRecord, "recentHookIds">,
  hookId: string,
): boolean {
  return record.recentHookIds.includes(hookId);
}

/** Record a hook id as seen, bounded to `HOOK_ID_LEDGER_CAPACITY`. */
export function rememberHookId(
  record: Pick<SessionRecord, "recentHookIds">,
  hookId: string,
): void {
  if (record.recentHookIds.includes(hookId)) return;
  record.recentHookIds.push(hookId);
  const over = record.recentHookIds.length - HOOK_ID_LEDGER_CAPACITY;
  if (over > 0) record.recentHookIds.splice(0, over);
}

/**
 * Which of two records for the same session id a caller that named no agent
 * means: a live chain over a sealed one, then the more recently seen.
 * `lastSeenAt` is a protocol timestamp, so it sorts as text.
 */
function preferRecord(candidate: SessionRecord, best: SessionRecord): boolean {
  if (candidate.sealed !== best.sealed) return !candidate.sealed;
  return candidate.lastSeenAt > best.lastSeenAt;
}

/** The optional session facts, copied only when set (the state file omits absent keys). */
function optionalFacts(facts: SessionFacts): SessionFacts {
  return {
    ...(facts.harness !== undefined ? { harness: facts.harness } : {}),
    ...(facts.customAgent !== undefined
      ? { customAgent: facts.customAgent }
      : {}),
    ...(facts.transcriptPath !== undefined
      ? { transcriptPath: facts.transcriptPath }
      : {}),
    ...(facts.cwd !== undefined ? { cwd: facts.cwd } : {}),
    ...(facts.pid !== undefined ? { pid: facts.pid } : {}),
    ...(facts.lastHookEvent !== undefined
      ? { lastHookEvent: facts.lastHookEvent }
      : {}),
    // Persisted with the rest. A daemon that restarts mid-session and comes
    // back without these takes its next baseline from the `HEAD` the session's
    // own commits have already moved, and everything committed before the
    // restart leaves the record — which is what the baseline exists to stop.
    ...(facts.baselineCommit !== undefined
      ? { baselineCommit: facts.baselineCommit }
      : {}),
    ...(facts.baselines !== undefined
      ? { baselines: { ...facts.baselines } }
      : {}),
    ...(facts.closedIdle === true ? { closedIdle: true } : {}),
  };
}

/**
 * Whether a hook reopens the sealed chain it arrived for. `SessionStart` is a
 * resume (`--resume`, `--continue`): the harness keeps the session id, so the
 * chain continues at its cursor. Any hook reopens a chain the sweep closed
 * only because it went quiet. A caller that is not a hook (OTel, the
 * transcript detector) never does. A chain whose terminal has not reached
 * the WAL stays closed: a frame sealed now would take a sequence number
 * after a terminal that a failed write may still discard.
 */
function reopens(record: SessionRecord, facts: SessionFacts): boolean {
  if (!record.sealed || record.pendingTerminal === true) return false;
  if (facts.lastHookEvent === undefined) return false;
  return facts.lastHookEvent === "SessionStart" || record.closedIdle === true;
}

function copyTombstone(tombstone: ChainTombstone): ChainTombstone {
  return { ...tombstone, cursor: { ...tombstone.cursor } };
}

/** A tombstone read back from disk, checked before a chain continues from it. */
function isTombstone(value: unknown): value is ChainTombstone {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Partial<ChainTombstone>;
  return (
    typeof t.key === "string" &&
    typeof t.sessionUuid === "string" &&
    typeof t.forgottenAt === "string" &&
    Number.isInteger(t.turnSeq) &&
    typeof t.cursor === "object" &&
    t.cursor !== null &&
    Number.isInteger(t.cursor.seq) &&
    t.cursor.seq > 0 &&
    isSha256Digest(t.cursor.prevHash)
  );
}

/** The most repositories one session keeps a baseline for. */
export const MAX_SESSION_BASELINES = 16;

/**
 * Make the baseline for the repository at `repoRoot` the session's
 * `baselineCommit`, and return it: the one the session already holds for
 * that repository, or `headSha` on its first read there. Keyed by
 * repository root rather than by `cwd`, so a `cd packages/foo` keeps the
 * commit the session started on and everything it committed since stays
 * measured. A `baselineCommit` with no entry yet (a state file written
 * before `baselines`) belongs to the current repository, because `ensure`
 * clears it on every move.
 */
export function rememberBaseline(
  record: Pick<SessionFacts, "baselineCommit" | "baselines">,
  repoRoot: string,
  headSha: string,
): string {
  const baselines = { ...record.baselines };
  const kept = baselines[repoRoot] ?? record.baselineCommit ?? headSha;
  // The most recently read goes last, so the bound drops the repository the
  // session left longest ago.
  delete baselines[repoRoot];
  baselines[repoRoot] = kept;
  const roots = Object.keys(baselines);
  for (const root of roots.slice(
    0,
    Math.max(0, roots.length - MAX_SESSION_BASELINES),
  ))
    delete baselines[root];
  record.baselines = baselines;
  record.baselineCommit = kept;
  return kept;
}
