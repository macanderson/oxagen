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
import type { ClaudeCodeContext } from "../claude-code/context";
import { type RecorderState, SessionRecorder } from "../claude-code/recorder";
import type { TachoEvent, TachoRuntime } from "../envelope";
import { COMMAND_HOOK_TIMEOUTS_S } from "../host/settings-writer";
import { toProtocolTimestamp } from "../timestamp";
import {
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
  /**
   * What the current pause did to the agent. `refused`: a boundary denied
   * the agent a tool call because of it, so the agent may be about to end
   * its turn on that refusal. `stopped`: the agent ended its turn while
   * paused (a `Stop` or a `StopFailure`), so nothing is running to resume.
   * Absent while the pause has touched nothing. Resume reads it to decide
   * whether the agent is owed a continuation (`resumeOwed`).
   */
  pauseEffect?: "refused" | "stopped";
  /**
   * The id of a resume that owes the agent a continuation: the next boundary
   * that can carry text tells it the operator resumed it. The resume command
   * was acknowledged when it applied, so delivering this seals a frame and
   * sends no second acknowledgement.
   */
  resumeOwed?: string;
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
   * `Stop` it did not.
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
   * Set on the first git read for the session in a given `cwd`, which is the
   * earliest this daemon knows that repository at all. Bound to the
   * worktree: when `ensure` sees a new `cwd`, the baseline is cleared and
   * the next read captures the new one. Persisted through `state` /
   * `restore` so a daemon restart does not lose it mid-session.
   *
   * A session that commits before that first read measures from after the
   * commit; that is a smaller window than measuring from `HEAD` every time,
   * and it is the honest limit of a baseline nobody recorded at the start.
   */
  baselineCommit?: string;
  /**
   * The repository root `baselineCommit` was taken in. A session can edit
   * a different worktree from the one it started in, so the baseline is bound
   * to the root it was read from and is retaken when the work moves to
   * another root.
   */
  baselineRoot?: string;
  /**
   * The directory of the file the agent last wrote. The session's `cwd` is
   * where it started. An agent working in a git worktree often keeps that
   * `cwd` on the primary checkout and edits files by absolute path, so git
   * read from `cwd` described the primary checkout on `main`. The run then
   * showed no branch, no diff, and a PR somebody once opened from `main`.
   * Git reads start here when it is set.
   */
  workDir?: string;
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
   * The hooks this session recorded, as `ledger key -> epoch ms` in the
   * order they were recorded. `tacho-hook` generates a `hook_id` when it
   * reads stdin and sends it on both the live request and the spool file it
   * falls back to when that request times out on the client's own side. A
   * client timeout does not mean the daemon never got the hook, only that
   * the client stopped waiting for the answer, so the same hook can arrive
   * twice: once live, once as a later spool replay. A hook sent without a
   * `hook_id` is keyed on its harness tool-call id where it has one (see
   * `hookLedgerKey` in the hook handler).
   *
   * A key stays until a complete spool drain runs `HOOK_ID_REPLAY_WINDOW_MS`
   * past it (see `pruneHookIds`), with `HOOK_ID_LEDGER_CEILING` as a
   * backstop. See `sawHookId` and `rememberHookId`.
   */
  hookIds: Map<string, number>;
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
  /** `SessionRecord.hookIds` as `[key, epoch ms]` pairs, oldest first. */
  hookIds?: Array<[string, number]>;
  /**
   * The ledger as files written before it carried times held it: ids only,
   * capped at 64. `restore` dates each one at the session's `lastSeenAt`.
   */
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
}

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
      if (facts.transcriptPath !== undefined)
        existing.transcriptPath = facts.transcriptPath;
      if (facts.cwd !== undefined) {
        // The baseline is a commit in the previous worktree. Keeping it
        // after a move makes reconciliation diff against a sha that may
        // not exist here, fall back to the new HEAD, and drop work the
        // session already committed in the new tree.
        // A session that writes files by path reads git from `workDir`, and
        // its baseline stays with that root whatever `cwd` does.
        if (
          existing.cwd !== undefined &&
          facts.cwd !== existing.cwd &&
          existing.workDir === undefined
        ) {
          delete existing.baselineCommit;
          delete existing.baselineRoot;
        }
        existing.cwd = facts.cwd;
      }
      if (facts.pid !== undefined) existing.pid = facts.pid;
      if (facts.lastHookEvent !== undefined)
        existing.lastHookEvent = facts.lastHookEvent;
      if (facts.baselineCommit !== undefined)
        existing.baselineCommit = facts.baselineCommit;
      if (facts.baselineRoot !== undefined)
        existing.baselineRoot = facts.baselineRoot;
      if (facts.workDir !== undefined) existing.workDir = facts.workDir;
      if (facts.ambient === false) existing.ambient = false;
      existing.lastSeenAt = now;
      this.noteAgent(existing, false);
      return { record: existing, created: false };
    }
    const record: SessionRecord = {
      harnessSessionId,
      recorder: new SessionRecorder({
        context: contextForHarness(
          this.options.context,
          facts.harness,
          facts.customAgent,
        ),
        harnessSessionId,
        scope: this.options.scope,
        ...(facts.customAgent === undefined
          ? {}
          : { customAgent: facts.customAgent }),
      }),
      control: { paused: null, cancelled: null, messages: [] },
      startedAt: now,
      lastSeenAt: now,
      sealed: false,
      lastCheckpointSeq: -1,
      ambient: facts.ambient ?? false,
      toolUseIds: {},
      hookIds: new Map(),
      ...optionalFacts(facts),
    };
    this.sessions.set(this.key(harnessSessionId, facts), record);
    this.noteAgent(record, true);
    return { record, created: true };
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
    if (record) record.sealed = true;
  }

  /**
   * Forget sealed sessions older than `retainMs`, and report the harness
   * session ids dropped. The roster keeps them counted.
   */
  forgetSealed(retainMs: number): string[] {
    const cutoff = this.options.now() - retainMs;
    const removed: string[] = [];
    for (const [key, record] of this.sessions) {
      if (record.sealed && Date.parse(record.lastSeenAt) < cutoff) {
        this.sessions.delete(key);
        removed.push(record.harnessSessionId);
      }
    }
    return removed;
  }

  /**
   * Close chains whose process is gone (or, with no pid known, idle past
   * `idleMs`). Returns the sealing events. A session whose process is gone
   * right after a `Stop` hook completed its turn and exited: that is how
   * Stella, which has no SessionEnd, ends every session, so it closes as
   * `completed`. Anything else closes as `crashed`, including a session
   * that only ever showed up through OTel or a transcript: the harness
   * never told us it ended.
   */
  sweep(
    isAlive: (pid: number) => boolean,
    idleMs: number,
    deferSeal: (session: SessionRecord) => boolean = () => false,
  ): TachoEvent[] {
    const out: TachoEvent[] = [];
    const now = this.options.now();
    for (const record of this.sessions.values()) {
      if (record.sealed || deferSeal(record)) continue;
      const gone = record.pid !== undefined ? !isAlive(record.pid) : false;
      const idle = now - Date.parse(record.lastSeenAt) > idleMs;
      if (!gone && !(record.pid === undefined && idle)) continue;
      if (!record.recorder.hasStarted) {
        record.sealed = true;
        continue;
      }
      const outcome =
        gone && record.lastHookEvent === "Stop" ? "completed" : "crashed";
      // The session ended when it was last seen, not when the sweep noticed:
      // an idle session swept six hours late would otherwise read as having
      // run six hours longer (#4024). `lastSeenAt` is the receipt time of its
      // last activity, so it is at or after every event its hooks sealed.
      out.push(...record.recorder.finalize(outcome, record.lastSeenAt));
      record.sealed = true;
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
          ...(record.control.pauseEffect !== undefined
            ? { pauseEffect: record.control.pauseEffect }
            : {}),
          ...(record.control.resumeOwed !== undefined
            ? { resumeOwed: record.control.resumeOwed }
            : {}),
        },
        startedAt: record.startedAt,
        lastSeenAt: record.lastSeenAt,
        sealed: record.sealed,
        lastCheckpointSeq: record.lastCheckpointSeq,
        ambient: record.ambient,
        ...(Object.keys(record.toolUseIds).length > 0
          ? { toolUseIds: { ...record.toolUseIds } }
          : {}),
        ...(record.hookIds.size > 0 ? { hookIds: [...record.hookIds] } : {}),
        ...optionalFacts(record),
      })),
      agents: [...this.roster.values()].map((entry) => ({ ...entry })),
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
          // Absent in state files written before resume owed a continuation.
          ...(persisted.control.pauseEffect !== undefined
            ? { pauseEffect: persisted.control.pauseEffect }
            : {}),
          ...(persisted.control.resumeOwed !== undefined
            ? { resumeOwed: persisted.control.resumeOwed }
            : {}),
        },
        startedAt: persisted.startedAt,
        lastSeenAt: persisted.lastSeenAt,
        sealed: persisted.sealed,
        lastCheckpointSeq: persisted.lastCheckpointSeq,
        ambient: persisted.ambient,
        toolUseIds: { ...persisted.toolUseIds },
        hookIds: restoredHookIds(persisted),
        ...optionalFacts(persisted),
      });
    }
    for (const entry of state.agents ?? []) {
      this.roster.set(entry.key, { ...entry });
    }
  }
}

/**
 * How long a hook stays in a session's ledger once a complete spool drain
 * could have seen its replay: the longest a harness lets `tacho-hook` run
 * (`COMMAND_HOOK_TIMEOUTS_S.PermissionRequest`), plus a minute for the
 * client to write its spool file after it gives up. A client names a hook
 * when it reads stdin, before the daemon receives it, so every spool file
 * for a hook the daemon recorded at `t` exists by `t` plus this window.
 */
export const HOOK_ID_REPLAY_WINDOW_MS =
  (Math.max(...Object.values(COMMAND_HOOK_TIMEOUTS_S)) + 60) * 1_000;

/**
 * The most hooks one session's ledger holds whatever their age. It only
 * matters when the spool never drains to empty (a file that keeps failing
 * transiently), and it holds about an hour of an agent's busiest pace.
 */
export const HOOK_ID_LEDGER_CEILING = 4_096;

/**
 * Whether this session's ledger already holds this key: a client-side
 * timeout followed by a spool replay of the hook the daemon already
 * processed live. See `SessionRecord.hookIds`.
 */
export function sawHookId(
  record: Pick<SessionRecord, "hookIds">,
  key: string,
): boolean {
  return record.hookIds.has(key);
}

/**
 * Record a key as seen at `at` (epoch ms), evicting the oldest past
 * `HOOK_ID_LEDGER_CEILING`. A key already held keeps its first time.
 */
export function rememberHookId(
  record: Pick<SessionRecord, "hookIds">,
  key: string,
  at: number,
): void {
  if (record.hookIds.has(key)) return;
  record.hookIds.set(key, at);
  for (const oldest of record.hookIds.keys()) {
    if (record.hookIds.size <= HOOK_ID_LEDGER_CEILING) break;
    record.hookIds.delete(oldest);
  }
}

/**
 * Drop a key from the ledger. The daemon calls this when a hook routed
 * but its frames never reached the WAL: the client saw a failure and spools
 * the same id, and that replay has to be sealed, not dropped as a repeat.
 */
export function forgetHookId(
  record: Pick<SessionRecord, "hookIds">,
  key: string,
): void {
  record.hookIds.delete(key);
}

/**
 * Drop every key recorded before `before` (epoch ms) and return how many
 * went. The daemon calls this after a spool drain that left nothing behind,
 * with `before` set `HOOK_ID_REPLAY_WINDOW_MS` earlier than the moment it
 * listed the spool: any replay of an older key was in that listing.
 */
export function pruneHookIds(
  record: Pick<SessionRecord, "hookIds">,
  before: number,
): number {
  let removed = 0;
  for (const [key, at] of record.hookIds) {
    if (at >= before) continue;
    record.hookIds.delete(key);
    removed += 1;
  }
  return removed;
}

/**
 * The ledger a state file holds. A file written before the ledger carried
 * times has ids only, so each is dated at the session's `lastSeenAt`, which
 * is no earlier than when the daemon recorded it.
 */
function restoredHookIds(persisted: PersistedSession): Map<string, number> {
  if (persisted.hookIds !== undefined) return new Map(persisted.hookIds);
  const at = Date.parse(persisted.lastSeenAt);
  return new Map(
    (persisted.recentHookIds ?? []).map((id): [string, number] => [id, at]),
  );
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
    ...(facts.baselineRoot !== undefined
      ? { baselineRoot: facts.baselineRoot }
      : {}),
    ...(facts.workDir !== undefined ? { workDir: facts.workDir } : {}),
  };
}
