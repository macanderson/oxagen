/**
 * The in-memory session recorder: takes normalized drafts from the four
 * Claude Code sources, fills the envelope from sticky per-session context,
 * assigns dense `seq`, and seals each event into the chain. Subagent
 * activity (any hook or record carrying an `agent_id`) is routed to a child
 * recorder with its own chain, linked by `parent_session_uuid`.
 *
 * Pure with respect to I/O: the collector owns persistence, clocks, and the
 * mapping from a running `claude` process to a recorder.
 */
import { z } from "zod";
import { isWrappedHarness } from "../wire";
import { type ChainCursor, GENESIS_CURSOR, sealEvent } from "../chain";
import type {
  BodyOf,
  TachoEvent,
  TachoKind,
  UnsealedTachoEvent,
} from "../envelope";
import {
  agentIdentitySchema,
  anthropicSchema,
  contextSchema,
  hostSchema,
  withoutAddressMembers,
} from "../envelope";
import {
  contentClassOf,
  type DraftContent,
  type FrameBody,
  prepareContent,
  textContent,
} from "../evidence/frame-body";
import { newEventId, sessionUuid } from "../ids";
import {
  LLM_CALL_DUPLICATE_OF_ATTR,
  LlmCallLedger,
  type LlmCallLedgerState,
  withoutUsage,
} from "./llm-call-dedupe";
import {
  TOOL_CALL_DUPLICATE_OF_ATTR,
  ToolCallLedger,
  type ToolCallLedgerState,
} from "./tool-call-dedupe";
import { toProtocolTimestamp } from "../timestamp";
import {
  type ClaudeCodeContext,
  DEFAULT_SECRET_ENV_PATTERN,
  harnessVersionFromExecPath,
  snapshotEnv,
} from "./context";
import { type HookDraft, normalizeHook, TURN_END_REASON_ATTR } from "./hooks";
import {
  type OtelDraft,
  type OtelMetricPoint,
  normalizeOtlp,
  type OtlpPayload,
} from "./otel";
import { inventoryFromInit, totalsFromResult } from "./result";
import {
  normalizeTranscriptLine,
  type SessionTitleSource,
  type TranscriptTotals,
} from "./transcript";

type Context = NonNullable<TachoEvent["context"]>;
type Host = NonNullable<TachoEvent["host"]>;
type Anthropic = NonNullable<TachoEvent["anthropic"]>;

/**
 * The next value of every sticky field `absorbStandard` used to write
 * straight onto the recorder, computed but not yet assigned. Building this
 * ahead of `seal()` lets a refused row leave `this.anthropic`, `this.context`,
 * `this.host` and `this.harnessVersion` exactly as they were: the caller
 * assigns it only once the row the update carries has cleared validation.
 */
interface StandardUpdate {
  anthropic: Anthropic;
  context: Context;
  host: Host;
  harnessVersion: string | undefined;
}

/** A sighting's attrs (undefined: a repeat not to seal) and its commit. */
interface SightingAttrs {
  attrs: Record<string, string> | undefined;
  commit: () => void;
}

/** What a row no ledger judges takes part in: nothing. */
const NO_SIGHTING: SightingAttrs = { attrs: {}, commit: () => {} };

/**
 * The attr on a frame sealed on a chain that has already sealed its
 * `agent_stop`. Such a frame is kept, because it is still a fact about the
 * session, but a reader must not take it for activity of a live session.
 */
export const AFTER_STOP_ATTR = "oxagen.after_stop";

/**
 * The attr on an OTel record that names a subagent type more than one
 * subagent of this session could have been, sealed on the session's own
 * chain rather than guessed onto one of them.
 */
export const SUBAGENT_TYPE_AMBIGUOUS_ATTR = "oxagen.subagent_type_ambiguous";

/**
 * How long after a subagent stops an OTel record naming only its type is
 * still taken for it. Claude Code exports logs in batches, so a subagent's
 * last `api_request` often arrives after its `SubagentStop`.
 */
const RECENTLY_CLOSED_MS = 30_000;

export interface RecorderOptions {
  context: ClaudeCodeContext;
  /** The harness's own session id (Claude Code's UUID). */
  harnessSessionId: string;
  /** Host enrollment id (Claude Code hosts) or agent key (SDK agents). */
  scope: string;
  /**
   * The custom agent that owns this session, when one does. A harness session
   * id is unique only within the agent that issued it, and the chain uuid is
   * derived from that id, so two custom agents handing out the same id would
   * otherwise derive one uuid and share a chain. Restored chains retain
   * their recorded UUID, including states written before harness scoping.
   */
  customAgent?: string;
  parent?: {
    sessionUuid: string;
    rootSessionUuid: string;
    subagentId: string;
    subagentType?: string;
    spawnToolUseId?: string;
    spawnDepth: number;
  };
  /** Continue a chain the collector persisted before a restart. */
  restore?: RecorderState;
}

interface SubagentLink {
  recorder: SessionRecorder;
  type?: string;
  open: boolean;
  /** When the subagent stopped, in epoch ms, for routing its late records. */
  closedAt?: number;
}

/** Everything a recorder needs to continue its chain after a restart. */
export interface RecorderState {
  /** Absent in legacy states, whose UUID uses the original unscoped seed. */
  sessionUuid?: string;
  cursor: ChainCursor;
  turnSeq: number;
  turnOpen: boolean;
  promptId?: string;
  started: boolean;
  stopped: boolean;
  context: Context;
  host: Host;
  anthropic: Anthropic;
  harnessVersion?: string;
  envSnapshot?: Record<string, string>;
  totals: Partial<TranscriptTotals>;
  /** Model calls already sealed, keyed as `llm-call-dedupe.ts` keys them. */
  llmCalls?: LlmCallLedgerState;
  /** Tool calls already sealed, by `tool_use_id`; see `tool-call-dedupe.ts`. */
  toolCalls?: ToolCallLedgerState;
  children: Record<
    string,
    {
      state: RecorderState;
      type?: string;
      open: boolean;
      spawnToolUseId?: string;
    }
  >;
}

/**
 * Where one chain stands, taken before a caller seals events it may not be
 * able to write, and handed back to {@link SessionRecorder.rollbackChain} when
 * the write fails.
 *
 * It names one recorder and the subagent chains below it, and nothing else.
 * A caller holding several sessions' recorders — the daemon's git lane holds
 * up to four in one tick — rolls one of them back without rebuilding the
 * others, which a registry-wide snapshot cannot do: that replaces every
 * `SessionRecord` in the registry and detaches the recorders the caller is
 * still holding for the sessions it has not settled yet.
 */
export interface ChainMark {
  cursor: ChainCursor;
  /** Events sealed on this chain when the mark was taken. */
  events: number;
  /** Bodies waiting for the caller that takes the events with them. */
  pendingBodies: number;
  pendingChildGenesis: number;
  turnSeq: number;
  turnOpen: boolean;
  promptId: string | undefined;
  started: boolean;
  stopped: boolean;
  llmCalls: LlmCallLedgerState;
  toolCalls: ToolCallLedgerState;
  /** One mark per subagent chain open at the time, by subagent id. */
  children: Map<
    string,
    {
      mark: ChainMark;
      type: string | undefined;
      open: boolean;
      closedAt: number | undefined;
    }
  >;
}

export interface SessionSnapshot {
  sessionUuid: string;
  harnessSessionId: string;
  events: TachoEvent[];
  children: SessionSnapshot[];
  totals: Partial<TranscriptTotals>;
  metrics: OtelMetricPoint[];
}

function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) out[key] = member;
  }
  return out as T;
}

/**
 * Seal an event, keeping any body member its kind does not declare as an
 * attribute rather than refusing the event.
 *
 * A harness adds attributes before this package learns their names: Claude
 * Code began sending `plugin.name` and `plugin_id_hash` on its MCP connection
 * records, and the strict body schema refused every such record, and with it
 * the whole OTLP export it arrived in. The envelope stays strict about its
 * typed members; an unknown one is kept verbatim in `attrs` under
 * `body.<key>`, the same way `hooks.ts` and `otel.ts` keep what they do not
 * promote. Any other refusal still throws.
 */
function sealWithUnknownBodyKeysAsAttrs(
  unsealed: UnsealedTachoEvent,
  cursor: ChainCursor,
): ReturnType<typeof sealEvent> {
  try {
    return sealEvent(unsealed, cursor);
  } catch (error) {
    const issues = (error as { issues?: unknown }).issues;
    if (!Array.isArray(issues)) throw error;
    const unknown = new Set<string>();
    for (const issue of issues as Array<{
      code?: string;
      path?: unknown[];
      keys?: string[];
    }>) {
      if (
        issue.code === "unrecognized_keys" &&
        issue.path?.length === 1 &&
        issue.path[0] === "body"
      )
        for (const key of issue.keys ?? []) unknown.add(key);
    }
    if (unknown.size === 0) throw error;
    const body = { ...(unsealed.body as Record<string, unknown>) };
    const attrs: Record<string, string> = { ...(unsealed.attrs ?? {}) };
    for (const key of unknown) {
      const value = body[key];
      delete body[key];
      if (value !== undefined)
        attrs[`body.${key}`] =
          typeof value === "string" ? value : JSON.stringify(value);
    }
    return sealEvent(
      { ...unsealed, body, attrs } as UnsealedTachoEvent,
      cursor,
    );
  }
}

export class SessionRecorder {
  readonly sessionUuid: string;
  readonly rootSessionUuid: string;
  readonly harnessSessionId: string;
  private options: RecorderOptions;
  private cursor: ChainCursor = GENESIS_CURSOR;
  private readonly events: TachoEvent[] = [];
  private readonly children = new Map<string, SubagentLink>();
  /** Genesis events sealed by child creation, drained by the ingest that caused it. */
  private pendingChildGenesis: TachoEvent[] = [];
  /**
   * Bodies of events sealed since the last `takeBodies`. The chain hash
   * covers the digest, never the bytes, so the bytes cannot live on the
   * event; they wait here for the daemon to write them next to it.
   */
  private pendingBodies: FrameBody[] = [];
  private readonly otelRefusals: string[] = [];
  /** Events `everySealed` had to add back, drained by the daemon's log. */
  private readonly sealRepairs: string[] = [];
  private context: Context = {};
  private host: Host = {};
  private anthropic: Anthropic = {};
  private harnessVersion: string | undefined;
  private turnSeq = 0;
  private turnOpen = false;
  private promptId: string | undefined;
  private started = false;
  private stopped = false;
  private envSnapshot: Record<string, string> | undefined;
  readonly totals: Partial<TranscriptTotals> = {};
  readonly metrics: OtelMetricPoint[] = [];
  private llmCalls = new LlmCallLedger();
  private toolCalls = new ToolCallLedger();
  /**
   * The session's own recorder, on a subagent's. A call is reported on both
   * chains (the hook on the subagent's, OTel with no `agent_id` and the model
   * proxy on the session's), so the two ledgers above are the root's for the
   * whole family, and a subagent's own stay empty. The root marks, rolls back
   * and persists them.
   */
  private familyRoot: SessionRecorder | undefined;

  constructor(options: RecorderOptions) {
    this.options = options;
    this.harnessSessionId = options.harnessSessionId;
    const seed =
      options.customAgent === undefined
        ? options.harnessSessionId
        : `${options.customAgent}/${options.harnessSessionId}`;
    const harness = options.context.agent.harness;
    const scopeHarness =
      options.restore === undefined &&
      options.customAgent === undefined &&
      harness !== "claude-code" &&
      isWrappedHarness(harness);
    const scopedSeed = scopeHarness ? `${harness}/${seed}` : seed;
    // A child always derives from its parent's recorded uuid. Gating this on
    // the child's own `restore` state made the derivation change across a
    // restart (a restored child took the unscoped seed while the live child
    // used the parent's uuid), splitting one subagent into two chains.
    const derived = options.parent
      ? sessionUuid(
          options.scope,
          `${options.parent.sessionUuid}/agent/${options.parent.subagentId}`,
        )
      : sessionUuid(options.scope, scopedSeed);
    this.sessionUuid =
      options.restore?.sessionUuid === undefined
        ? derived
        : z.string().uuid().parse(options.restore.sessionUuid);
    this.rootSessionUuid = options.parent?.rootSessionUuid ?? this.sessionUuid;
    this.harnessVersion = options.context.agent.harness_version;
    if (options.context.host) this.host = { ...options.context.host };
    if (options.restore) this.restore(options.restore);
  }

  private restore(state: RecorderState): void {
    this.cursor = { ...state.cursor };
    this.turnSeq = state.turnSeq;
    this.turnOpen = state.turnOpen;
    this.promptId = state.promptId;
    this.started = state.started;
    this.stopped = state.stopped;
    this.context = { ...state.context };
    this.host = { ...state.host };
    // Scrubbed on the way IN, not only on the way out. A collector upgraded
    // mid-session restores a daemon-state file the PREVIOUS build wrote, and
    // that file still carries `anthropic.user_email` in plaintext. Spreading it
    // unchanged put the address back into every event this recorder went on to
    // seal — and into the chain hash sealed over it — for the rest of the
    // session. Removing the member from `standard()` never reached that state,
    // because it was persisted before the fix existed (#3072).
    this.anthropic = withoutAddressMembers({ ...state.anthropic });
    this.harnessVersion = state.harnessVersion ?? this.harnessVersion;
    this.envSnapshot = state.envSnapshot;
    Object.assign(this.totals, state.totals);
    this.llmCalls = new LlmCallLedger(state.llmCalls);
    this.toolCalls = new ToolCallLedger(state.toolCalls);
    for (const [subagentId, link] of Object.entries(state.children)) {
      const recorder = new SessionRecorder({
        context: this.options.context,
        harnessSessionId: this.harnessSessionId,
        scope: this.options.scope,
        ...(this.options.customAgent === undefined
          ? {}
          : { customAgent: this.options.customAgent }),
        parent: {
          sessionUuid: this.sessionUuid,
          rootSessionUuid: this.rootSessionUuid,
          subagentId,
          ...(link.type !== undefined ? { subagentType: link.type } : {}),
          ...(link.spawnToolUseId !== undefined
            ? { spawnToolUseId: link.spawnToolUseId }
            : {}),
          spawnDepth: (this.options.parent?.spawnDepth ?? 0) + 1,
        },
        restore: link.state,
      });
      // A state written while each chain kept its own ledgers holds the
      // subagent's calls on the subagent: they join the family's.
      this.llmCalls = new LlmCallLedger({
        keys: [
          ...this.llmCalls.state().keys,
          ...recorder.llmCalls.state().keys,
        ],
      });
      this.toolCalls = new ToolCallLedger({
        calls: [
          ...this.toolCalls.state().calls,
          ...recorder.toolCalls
            .state()
            .calls.map(
              ([id, sources, body]) =>
                [id, sources, body, subagentId] as [
                  string,
                  string[],
                  boolean,
                  string,
                ],
            ),
        ],
      });
      recorder.llmCalls = new LlmCallLedger();
      recorder.toolCalls = new ToolCallLedger();
      recorder.familyRoot = this.familyRoot ?? this;
      this.children.set(subagentId, {
        recorder,
        ...(link.type !== undefined ? { type: link.type } : {}),
        open: link.open,
      });
    }
  }

  /** The chain position and sticky context, for persistence across restarts. */
  state(): RecorderState {
    const children: RecorderState["children"] = {};
    for (const [subagentId, link] of this.children) {
      children[subagentId] = {
        state: link.recorder.state(),
        ...(link.type !== undefined ? { type: link.type } : {}),
        open: link.open,
        ...(link.recorder.options.parent?.spawnToolUseId !== undefined
          ? { spawnToolUseId: link.recorder.options.parent.spawnToolUseId }
          : {}),
      };
    }
    return {
      sessionUuid: this.sessionUuid,
      cursor: { ...this.cursor },
      turnSeq: this.turnSeq,
      turnOpen: this.turnOpen,
      ...(this.promptId !== undefined ? { promptId: this.promptId } : {}),
      started: this.started,
      stopped: this.stopped,
      context: { ...this.context },
      host: { ...this.host },
      anthropic: { ...this.anthropic },
      ...(this.harnessVersion !== undefined
        ? { harnessVersion: this.harnessVersion }
        : {}),
      ...(this.envSnapshot !== undefined
        ? { envSnapshot: this.envSnapshot }
        : {}),
      totals: { ...this.totals },
      llmCalls: this.llmCalls.state(),
      toolCalls: this.toolCalls.state(),
      children,
    };
  }

  /**
   * Where this chain stands now, so a caller can seal events and put the
   * chain back if the write that had to follow them failed.
   */
  markChain(): ChainMark {
    const children: ChainMark["children"] = new Map();
    for (const [subagentId, link] of this.children) {
      children.set(subagentId, {
        mark: link.recorder.markChain(),
        type: link.type,
        open: link.open,
        closedAt: link.closedAt,
      });
    }
    return {
      cursor: { ...this.cursor },
      events: this.events.length,
      pendingBodies: this.pendingBodies.length,
      pendingChildGenesis: this.pendingChildGenesis.length,
      turnSeq: this.turnSeq,
      turnOpen: this.turnOpen,
      promptId: this.promptId,
      started: this.started,
      stopped: this.stopped,
      llmCalls: this.llmCalls.state(),
      toolCalls: this.toolCalls.state(),
      children,
    };
  }

  /**
   * Undo every event this chain and its subagent chains sealed since the
   * mark, so the next attempt seals at the same sequence number the failed
   * one did.
   *
   * A seal moves the chain cursor in memory; the WAL write comes after. When
   * that write throws, the cursor has already advanced past an event nothing
   * will ever hold, and the retry seals its replacement one position further
   * on. What lands on disk then is a chain with a hole in it, whose next hash
   * commits to an event no verifier can read, and the record is neither
   * gap-free nor tamper-evident. This puts the cursor, the sealed events, the
   * bodies waiting to be written beside them, the turn and lifecycle flags a
   * seal sets, and the model-call and tool-call ledgers back where the mark
   * found them.
   *
   * Facts absorbed from a source are not chain positions and are left alone:
   * the git context, host and `anthropic` blocks, the transcript totals, the
   * OTel metrics and the environment snapshot. They were observed, the
   * observation still holds, and the frame the retry seals carries them.
   */
  rollbackChain(mark: ChainMark): void {
    for (const [subagentId, link] of [...this.children]) {
      const saved = mark.children.get(subagentId);
      // A subagent chain opened after the mark: its genesis is one of the
      // events being undone, so the chain goes with it.
      if (saved === undefined) {
        this.children.delete(subagentId);
        continue;
      }
      link.recorder.rollbackChain(saved.mark);
      this.children.set(subagentId, {
        recorder: link.recorder,
        ...(saved.type !== undefined ? { type: saved.type } : {}),
        open: saved.open,
        ...(saved.closedAt !== undefined ? { closedAt: saved.closedAt } : {}),
      });
    }
    this.cursor = { ...mark.cursor };
    this.events.splice(mark.events);
    this.pendingBodies.splice(mark.pendingBodies);
    this.pendingChildGenesis.splice(mark.pendingChildGenesis);
    this.turnSeq = mark.turnSeq;
    this.turnOpen = mark.turnOpen;
    this.promptId = mark.promptId;
    this.started = mark.started;
    this.stopped = mark.stopped;
    this.llmCalls = new LlmCallLedger(mark.llmCalls);
    this.toolCalls = new ToolCallLedger(mark.toolCalls);
  }

  /**
   * Take on the agent identity of the harness that claimed an ambient
   * session, and pass it to every child chain. Only the labels move: the
   * chain cursor, the events already sealed and the session uuid are the
   * recorder's own, so the chain continues rather than forking. The uuid is
   * seeded from the harness session id (and, for a custom agent, from the
   * agent), so a caller may only relabel between identities that seed it the
   * same way — `SessionRegistry.adopt` is the one that decides that.
   */
  relabel(context: ClaudeCodeContext): void {
    this.options = { ...this.options, context };
    for (const link of this.children.values()) link.recorder.relabel(context);
  }

  /**
   * Record context facts the collector observed rather than the harness
   * reported, such as the git head the worktree is on. They merge into the
   * context block the same way a hook's own facts do, so the next frame this
   * recorder seals carries them and every frame after it does too.
   */
  noteContext(facts: Partial<Context>): void {
    this.absorbContext(facts as Record<string, unknown>);
  }

  /** The chain head after the last sealed event. */
  get chainCursor(): ChainCursor {
    return this.cursor;
  }

  /**
   * Drain the bodies of every event sealed on this chain and its children
   * since the last drain. The caller that took the events takes these in the
   * same breath, so a body is written next to its event and never to a WAL
   * whose event is still in memory.
   */
  takeBodies(): FrameBody[] {
    const out = this.pendingBodies.splice(0);
    for (const link of this.children.values())
      out.push(...link.recorder.takeBodies());
    return out;
  }

  /** Open child recorders, for routing and status. */
  get openChildren(): ReadonlyMap<string, SessionRecorder> {
    const out = new Map<string, SessionRecorder>();
    for (const [id, link] of this.children) {
      if (link.open) out.set(id, link.recorder);
    }
    return out;
  }

  /**
   * Seal a collector-originated event on this chain (a policy decision, a
   * checkpoint, a gap, an applied command). Body members are the typed
   * columns of the kind; extra facts go to `attrs`.
   *
   * On a chain that has already sealed its `agent_stop` the frame is still
   * sealed, stamped {@link AFTER_STOP_ATTR}. A caller that can put it on the
   * host chain instead checks {@link isStopped} first.
   */
  sealCollectorEvent(
    kind: TachoKind,
    body: Record<string, unknown>,
    fields: {
      ts?: string;
      source?: TachoEvent["source"];
      hook_event_name?: string;
      attrs?: Record<string, string>;
      /**
       * `proxy` for a frame the loopback model proxy observed on the wire.
       * Everything else the collector seals is `sdk`, the default.
       */
      fidelity?: TachoEvent["fidelity"];
      /** The bytes this frame's `content.digest` names; see `HookDraft.content`. */
      content?: DraftContent;
    } = {},
  ): TachoEvent {
    if (kind === "agent_start") this.started = true;
    // `stopped` is set once the stop has sealed, so the stop itself is not
    // stamped as a frame that arrived after one.
    if (kind === "agent_stop") this.turnOpen = false;
    // A proxy frame is the first sighting of its call by construction (it
    // is sealed as the response ends); noting it is what lets the transcript
    // and OTel sightings that follow be stamped as its duplicates.
    const sighting =
      kind === "llm_call"
        ? this.llmCallSighting(body, fields.source ?? "collector")
        : NO_SIGHTING;
    const duplicate = sighting.attrs ?? {};
    const event = this.seal(kind, body, {
      ts: fields.ts ?? this.now(),
      source: fields.source ?? "collector",
      ...(fields.hook_event_name !== undefined
        ? { hook_event_name: fields.hook_event_name }
        : {}),
      attrs: { ...fields.attrs, ...duplicate },
      ...(fields.fidelity !== undefined ? { fidelity: fields.fidelity } : {}),
      ...(fields.content !== undefined ? { content: fields.content } : {}),
      turn: {},
    });
    sighting.commit();
    if (kind === "agent_stop") this.stopped = true;
    return event;
  }

  get hasStarted(): boolean {
    return this.started;
  }

  get hasStopped(): boolean {
    return this.stopped;
  }

  /**
   * Whether this chain has sealed its `agent_stop`. Every frame sealed on it
   * from then on carries {@link AFTER_STOP_ATTR}, until a resume starts it
   * again.
   */
  get isStopped(): boolean {
    return this.stopped;
  }

  get sealedEvents(): readonly TachoEvent[] {
    return this.events;
  }

  private now(): string {
    return toProtocolTimestamp(this.options.context.now?.() ?? Date.now());
  }

  private child(
    subagentId: string,
    subagentType: string | undefined,
    spawnToolUseId: string | undefined,
    at?: string,
  ): SessionRecorder {
    const existing = this.children.get(subagentId);
    if (existing) {
      if (subagentType !== undefined && existing.type === undefined)
        existing.type = subagentType;
      return existing.recorder;
    }
    const recorder = new SessionRecorder({
      context: this.options.context,
      harnessSessionId: this.harnessSessionId,
      scope: this.options.scope,
      ...(this.options.customAgent === undefined
        ? {}
        : { customAgent: this.options.customAgent }),
      parent: {
        sessionUuid: this.sessionUuid,
        rootSessionUuid: this.rootSessionUuid,
        subagentId,
        ...(subagentType !== undefined ? { subagentType } : {}),
        ...(spawnToolUseId !== undefined ? { spawnToolUseId } : {}),
        spawnDepth: (this.options.parent?.spawnDepth ?? 0) + 1,
      },
    });
    recorder.context = { ...this.context };
    recorder.anthropic = { ...this.anthropic };
    recorder.host = { ...this.host };
    recorder.envSnapshot = this.envSnapshot;
    recorder.familyRoot = this.familyRoot ?? this;
    this.children.set(subagentId, {
      recorder,
      ...(subagentType !== undefined ? { type: subagentType } : {}),
      open: true,
    });
    // A child chain opens with its own genesis, so its journal has a session_start.
    recorder.started = true;
    const genesis = recorder.seal(
      "agent_start",
      {
        session_start_source: "subagent",
        ...(this.context.model !== undefined
          ? { model: this.context.model }
          : {}),
        ...(this.envSnapshot !== undefined
          ? { env_snapshot: this.envSnapshot }
          : {}),
      },
      {
        ts: at ?? this.now(),
        source: "collector",
        hook_source_kind: "subagent",
      },
    );
    this.pendingChildGenesis.push(genesis);
    return recorder;
  }

  /**
   * The subagent an OTel record naming only its type belongs to, or
   * "ambiguous" when more than one could have sent it. Two parallel `Explore`
   * agents are both open, and taking the last one opened sealed the first
   * one's calls on the second's chain. With none open, the record is one a
   * subagent sent before it stopped and the batch delivered after, so a
   * subagent of that type that stopped within `RECENTLY_CLOSED_MS` of it is
   * taken, if it is the only one.
   */
  private childByType(
    type: string,
    at: string,
  ): SessionRecorder | "ambiguous" | undefined {
    const links = [...this.children.values()].filter(
      (link) => link.type === type,
    );
    const open = links.filter((link) => link.open);
    const when = Date.parse(at);
    const candidates =
      open.length > 0
        ? open
        : links.filter(
            (link) =>
              link.closedAt !== undefined &&
              when - link.closedAt <= RECENTLY_CLOSED_MS,
          );
    if (candidates.length > 1) return "ambiguous";
    return candidates[0]?.recorder;
  }

  private seal(
    kind: TachoKind,
    body: Record<string, unknown>,
    fields: {
      ts: string;
      source: TachoEvent["source"];
      hook_event_name?: string;
      hook_source_kind?: string;
      otel_event_name?: string;
      harness_event_sequence?: number;
      attrs?: Record<string, string>;
      fidelity?: TachoEvent["fidelity"];
      span?: TachoEvent["span"];
      content_digest?: `sha256:${string}`;
      content?: DraftContent;
      raw_source_digest?: `sha256:${string}`;
      turn?: { prompt_id?: string; turn_id?: string };
    },
    /**
     * A not-yet-committed `StandardUpdate` to build this one envelope from,
     * in place of the recorder's own sticky `anthropic`/`context`/`host`/
     * `harnessVersion`. The caller (`sealOtelDraft`) commits it onto the
     * recorder only after this call returns, so a throw here never leaves
     * the sticky fields holding a value the envelope refused.
     */
    standard?: StandardUpdate,
  ): TachoEvent {
    const anthropic = standard?.anthropic ?? this.anthropic;
    const context = standard?.context ?? this.context;
    const host = standard?.host ?? this.host;
    const harnessVersion = standard?.harnessVersion ?? this.harnessVersion;
    const parent = this.options.parent;
    // Redacted and digested here, before the seal, so the digest the chain
    // hash covers is the digest of the bytes that ship. A frame with bytes
    // chains that digest; one with only a `content_digest` (an OTel record,
    // whose bytes the harness never handed over) chains the digest as given.
    const prepared =
      fields.content !== undefined ? prepareContent(fields.content) : undefined;
    const content =
      prepared !== undefined
        ? { digest: prepared.digest, redactions: prepared.redactions }
        : fields.content_digest !== undefined
          ? { digest: fields.content_digest, redactions: [] }
          : undefined;
    const attrs = {
      ...fields.attrs,
      ...(prepared?.omitted !== undefined
        ? { body_omitted: prepared.omitted }
        : {}),
      ...(prepared !== undefined && prepared.redactionsTotal > 0
        ? {
            "oxagen.content_redactions_total": String(prepared.redactionsTotal),
          }
        : {}),
      // The OTel exporter, the transcript tailer, the model proxy and the
      // inbox all outlive a session's end, and each can hand this chain a
      // frame after its `agent_stop`. The frame is a fact and is kept, but
      // marked, so no reader counts it as activity of a live session.
      ...(this.stopped ? { [AFTER_STOP_ATTR]: "1" } : {}),
    };
    const unsealed = compact({
      v: "tacho/1.0",
      event_id: newEventId(Date.parse(fields.ts)),
      session_id: this.harnessSessionId,
      session_uuid: this.sessionUuid,
      root_session_uuid: this.rootSessionUuid,
      parent_session_uuid: parent?.sessionUuid,
      ts: fields.ts,
      fidelity: fields.fidelity ?? "sdk",
      source: fields.source,
      hook_event_name: fields.hook_event_name,
      hook_source_kind: fields.hook_source_kind,
      otel_event_name: fields.otel_event_name,
      harness_event_sequence: fields.harness_event_sequence,
      agent: compact({
        ...this.options.context.agent,
        harness_version: harnessVersion,
      }),
      subagent: parent
        ? compact({
            subagent_id: parent.subagentId,
            subagent_type: parent.subagentType,
            spawn_depth: parent.spawnDepth,
            spawn_tool_use_id: parent.spawnToolUseId,
          })
        : undefined,
      turn:
        this.turnOpen || fields.turn?.prompt_id !== undefined
          ? compact({
              turn_seq: this.turnOpen ? this.turnSeq : undefined,
              prompt_id: fields.turn?.prompt_id ?? this.promptId,
              turn_id: fields.turn?.turn_id,
            })
          : undefined,
      context: Object.keys(context).length > 0 ? { ...context } : undefined,
      host: Object.keys(host).length > 0 ? { ...host } : undefined,
      anthropic:
        Object.keys(anthropic).length > 0 ? { ...anthropic } : undefined,
      span: fields.span,
      attrs,
      content,
      raw_source_digest: fields.raw_source_digest,
      kind,
      body,
    }) as unknown as UnsealedTachoEvent;
    const sealed = sealWithUnknownBodyKeysAsAttrs(unsealed, this.cursor);
    this.cursor = sealed.next;
    this.events.push(sealed.event);
    const contentClass = contentClassOf(kind);
    if (prepared?.body !== undefined && contentClass !== undefined) {
      this.pendingBodies.push({
        event_id_idem: sealed.event.event_id_idem,
        session_uuid: sealed.event.session_uuid,
        seq: sealed.event.seq,
        content_type: prepared.body.content_type,
        bytes: prepared.body.bytes,
        content_class: contentClass,
      });
    }
    return sealed.event;
  }

  private absorbContext(context: Record<string, unknown>): void {
    this.context = compact({ ...this.context, ...context }) as Context;
  }

  private absorbHost(host: Record<string, unknown>): void {
    this.host = compact({ ...this.host, ...host }) as Host;
    if (this.harnessVersion === undefined) {
      this.harnessVersion = harnessVersionFromExecPath(
        this.host.claude_execpath,
      );
    }
  }

  /**
   * The attrs an `llm_call` carries when another source already sealed the
   * same call, or undefined when this sighting is a repeat from the same
   * source and must not be sealed at all; and the ledger registration to
   * commit once the row has sealed. A row the envelope refuses never
   * commits, so the next sighting of the call is not stamped a duplicate of
   * a row the chain does not hold. See `llm-call-dedupe.ts`.
   */
  private llmCallSighting(
    body: Record<string, unknown>,
    source: string,
  ): SightingAttrs {
    const { verdict, commit } = (this.familyRoot ?? this).llmCalls.judge(
      body,
      source,
    );
    if (verdict.kind === "repeat") return { attrs: undefined, commit };
    if (verdict.kind === "duplicate")
      return { attrs: { [LLM_CALL_DUPLICATE_OF_ATTR]: verdict.of }, commit };
    return { attrs: {}, commit };
  }

  /**
   * The attrs a `tool_call` carries, or undefined when the chain already
   * holds this call and the row must not be sealed at all.
   *
   * A row from a source that reports a call another source already sealed is
   * a second copy of one call, not a second call, and sealing it put three
   * frames on the chain for every tool a session ran (#3661). The one row
   * that still seals is the one bringing the body a digest-only first
   * sighting could not, and it is stamped so a reader counts one call. See
   * `tool-call-dedupe.ts` and ADR-140.
   */
  private toolCallSighting(
    body: Record<string, unknown>,
    source: string,
    hasBody: boolean,
  ): SightingAttrs {
    const toolUseId =
      typeof body["tool_use_id"] === "string" ? body["tool_use_id"] : undefined;
    const { verdict, commit } = (this.familyRoot ?? this).toolCalls.judge(
      toolUseId,
      source,
      hasBody,
      this.options.parent?.subagentId,
    );
    if (verdict.kind === "repeat") return { attrs: undefined, commit };
    if (verdict.kind === "body")
      return { attrs: { [TOOL_CALL_DUPLICATE_OF_ATTR]: verdict.of }, commit };
    return { attrs: {}, commit };
  }

  /** Ingest one hook payload with the hook process environment. */
  ingestHook(
    raw: unknown,
    env: Record<string, string | undefined>,
    at?: string,
    rewrite?: (draft: HookDraft) => HookDraft,
  ): TachoEvent[] {
    return this.everySealed(() => this.sealHook(raw, env, at, rewrite));
  }

  private sealHook(
    raw: unknown,
    env: Record<string, string | undefined>,
    at?: string,
    rewrite?: (draft: HookDraft) => HookDraft,
  ): TachoEvent[] {
    const drafts = normalizeHook(raw, env, {
      sessionUuid: this.sessionUuid,
    }).map((draft) => (rewrite ? rewrite(draft) : draft));
    const first = drafts[0];
    const ts = at ?? this.now();
    if (first?.subagent && !this.options.parent) {
      const { subagent_id: subagentId, subagent_type: subagentType } =
        first.subagent;
      const spawnToolUseId =
        typeof first.body["tool_use_id"] === "string"
          ? first.body["tool_use_id"]
          : undefined;
      const isStart = first.hook_event_name === "SubagentStart";
      const child = this.child(subagentId, subagentType, spawnToolUseId, ts);
      const out: TachoEvent[] = this.pendingChildGenesis.splice(0);
      // The OTel records of this subagent's tool calls carry no `agent_id`,
      // only the `tool_use_id` this hook names first. The spawn's id is the
      // parent's own `Agent` call, not one of the subagent's.
      for (const draft of drafts) {
        const toolUseId = draft.body["tool_use_id"];
        if (
          typeof toolUseId === "string" &&
          draft.kind !== "subagent_start" &&
          draft.kind !== "subagent_stop"
        )
          this.toolCalls.claim(toolUseId, subagentId);
      }
      if (isStart) {
        // The parent records the spawn; the child opened its own chain above.
        this.absorbContext(first.context);
        out.push(
          this.seal(
            "subagent_start",
            {
              ...(spawnToolUseId !== undefined
                ? { tool_use_id: spawnToolUseId }
                : {}),
            },
            {
              ts,
              source: "hook",
              hook_event_name: first.hook_event_name,
              attrs: {
                ...first.attrs,
                "hook.agent_id": subagentId,
                ...(subagentType !== undefined
                  ? { "hook.agent_type": subagentType }
                  : {}),
              },
              raw_source_digest: first.raw_source_digest,
              turn: first.turn ?? {},
            },
          ),
        );
      }
      out.push(...child.ingestHook(raw, env, ts, rewrite));
      if (first.hook_event_name === "SubagentStop") {
        out.push(...child.finalize("completed", ts));
        const link = this.children.get(subagentId);
        if (link) {
          link.open = false;
          link.closedAt = Date.parse(ts);
        }
        out.push(
          this.seal(
            "subagent_stop",
            { ...first.body, tool_status: "ok" },
            {
              ts,
              source: "hook",
              hook_event_name: first.hook_event_name,
              attrs: {
                ...first.attrs,
                "hook.agent_id": subagentId,
                ...(subagentType !== undefined
                  ? { "hook.agent_type": subagentType }
                  : {}),
              },
              raw_source_digest: first.raw_source_digest,
              turn: first.turn ?? {},
            },
          ),
        );
      }
      return out;
    }
    const out: TachoEvent[] = [];
    for (const draft of drafts) {
      out.push(...this.sealHookDraft(draft, env, ts));
    }
    return out;
  }

  /**
   * The events this draft seals, in chain order. Empty for a call the chain
   * already holds. A `turn_start` on an open turn first seals the `turn_end`
   * that closes it; that event must be returned too, or its seq is spent on
   * an event that never reaches the WAL and the chain has a gap.
   */
  private sealHookDraft(
    draft: HookDraft,
    env: Record<string, string | undefined>,
    ts: string,
  ): TachoEvent[] {
    const out: TachoEvent[] = [];
    this.absorbContext(draft.context);
    this.absorbHost(draft.host);
    if (this.envSnapshot === undefined) {
      this.envSnapshot = snapshotEnv(
        env,
        this.options.context.secretEnvPattern ?? DEFAULT_SECRET_ENV_PATTERN,
      );
    }
    let body = draft.body;
    if (draft.kind === "agent_stop" && this.options.parent === undefined) {
      // A background subagent, or one whose SubagentStop never arrived, would
      // otherwise read as running for good on a session that has ended.
      out.push(...this.closeOpenChildren("aborted", ts));
      // The clean exit carries the transcript's totals, as the stop the
      // collector seals for a crash does.
      body = { ...this.sessionTotals(), ...body };
    }
    if (draft.kind === "agent_start") {
      if (this.started) {
        // A second SessionStart on a live chain is a resume or fork.
        body = {
          ...body,
          resume_of_session_id: this.harnessSessionId,
          resume_last_seq_seen: this.cursor.seq - 1,
        };
      }
      this.started = true;
      // A resume starts a stopped chain again, and what it seals is live.
      this.stopped = false;
      body = { ...body, env_snapshot: this.envSnapshot };
    }
    if (draft.kind === "turn_start") {
      if (this.turnOpen) {
        out.push(
          this.seal(
            "turn_end",
            {},
            { ts, source: "collector", hook_event_name: "UserPromptSubmit" },
          ),
        );
      }
      this.turnSeq += 1;
      this.turnOpen = true;
      this.promptId = draft.turn?.prompt_id;
    }
    if (draft.kind === "subagent_start" && draft.subagent === undefined) {
      // The parent-side view of a spawn (no agent_id on the payload).
      body = { ...body };
    }
    const sighting =
      draft.kind === "tool_call"
        ? this.toolCallSighting(body, "hook", draft.content !== undefined)
        : NO_SIGHTING;
    const duplicate = sighting.attrs;
    if (duplicate === undefined) {
      sighting.commit();
      return out;
    }
    const event = this.seal(draft.kind, body, {
      ts,
      source: "hook",
      hook_event_name: draft.hook_event_name,
      ...(draft.hook_source_kind !== undefined
        ? { hook_source_kind: draft.hook_source_kind }
        : {}),
      attrs: { ...draft.attrs, ...duplicate },
      ...(draft.content !== undefined ? { content: draft.content } : {}),
      raw_source_digest: draft.raw_source_digest,
      turn: draft.turn ?? {},
    });
    sighting.commit();
    if (draft.kind === "turn_end") {
      this.turnOpen = false;
    }
    if (draft.kind === "agent_stop") {
      this.stopped = true;
      this.turnOpen = false;
    }
    out.push(event);
    return out;
  }

  /** Ingest one OTLP/HTTP JSON payload. Records for other sessions are ignored. */
  ingestOtlp(payload: OtlpPayload): TachoEvent[] {
    return this.everySealed(() => this.sealOtlp(payload));
  }

  private sealOtlp(payload: OtlpPayload): TachoEvent[] {
    const { drafts, metrics } = normalizeOtlp(payload);
    const out: TachoEvent[] = [];
    for (const metric of metrics) {
      if (
        metric.standard.session_id !== undefined &&
        metric.standard.session_id !== this.harnessSessionId
      )
        continue;
      // No `seal()` guards a metric, so its standard fields are checked
      // against the same schemas `seal()` would refuse them against before
      // they ever reach the sticky state: a metric with an out-of-bounds
      // field must not poison it either.
      const standardUpdate = this.computeStandardUpdate(metric.standard);
      const refusal = this.refusedStandardReason(standardUpdate);
      if (refusal !== undefined) {
        this.otelRefusals.push(`metric: ${refusal}`);
        continue;
      }
      this.commitStandardUpdate(standardUpdate);
      this.metrics.push(metric);
    }
    for (const draft of drafts) {
      if (
        draft.standard.session_id !== undefined &&
        draft.standard.session_id !== this.harnessSessionId
      )
        continue;
      const { target, draft: routed } = this.routeOtel(draft);
      out.push(...this.pendingChildGenesis.splice(0));
      // One record the envelope refuses must not cost the rest of the export.
      // The events already sealed in this loop have advanced the chain; had
      // the throw escaped, they would never reach the WAL and the control
      // plane would see a sequence gap on every chain the export touched.
      try {
        const sealed = target.sealOtelDraft(routed);
        if (sealed !== undefined) out.push(sealed);
      } catch (error) {
        this.otelRefusals.push(
          `${draft.kind}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
      }
    }
    return out;
  }

  /**
   * Run one ingest and return every event it sealed, on this chain or on a
   * subagent's, in chain order.
   *
   * The daemon writes only the events an ingest returns. An event that is
   * sealed and not returned spends its seq without reaching the WAL, and the
   * control plane then reports a chain break that nothing can repair. A
   * dropped `turn_end` did this before every prompt that landed on an open
   * turn. Rather than trust every path to return what it seals, the guard
   * compares what was sealed with what came back and adds anything missing.
   * Child genesis events still waiting in `pendingChildGenesis` are left to
   * the ingest that drains them, so nothing is written twice. Each addition
   * is kept for `takeSealRepairs`, because an addition is a bug to fix.
   */
  private everySealed(run: () => TachoEvent[]): TachoEvent[] {
    const before = new Map<SessionRecorder, number>();
    for (const recorder of this.family()) {
      before.set(recorder, recorder.events.length);
    }
    const out = run();
    const accounted = new Set(out.map((event) => event.event_id));
    for (const recorder of this.family()) {
      for (const event of recorder.pendingChildGenesis) {
        accounted.add(event.event_id);
      }
    }
    const missed: TachoEvent[] = [];
    for (const recorder of this.family()) {
      for (const event of recorder.events.slice(before.get(recorder) ?? 0)) {
        if (!accounted.has(event.event_id)) missed.push(event);
      }
    }
    if (missed.length === 0) return out;
    for (const event of missed) {
      this.sealRepairs.push(`${event.session_uuid}#${event.seq} ${event.kind}`);
    }
    return inChainOrder([...out, ...missed]);
  }

  /** This recorder and every subagent recorder under it. */
  private *family(): Generator<SessionRecorder> {
    yield this;
    for (const link of this.children.values()) yield* link.recorder.family();
  }

  /**
   * Events the ingest guard added back because the path that sealed them did
   * not return them, across this chain and its subagents. Drained by the
   * daemon's log. Anything here is a recorder bug.
   */
  takeSealRepairs(): string[] {
    const out: string[] = [];
    for (const recorder of this.family()) {
      out.push(...recorder.sealRepairs.splice(0));
    }
    return out;
  }

  /** OTel records this recorder could not seal, drained by the daemon's log. */
  takeOtelRefusals(): string[] {
    return this.otelRefusals.splice(0);
  }

  private routeOtel(draft: OtelDraft): {
    target: SessionRecorder;
    draft: OtelDraft;
  } {
    if (this.options.parent) return { target: this, draft };
    if (draft.standard.agent_id !== undefined) {
      return {
        target: this.child(
          draft.standard.agent_id,
          draft.standard.agent_name,
          undefined,
          draft.ts,
        ),
        draft,
      };
    }
    // Claude Code's `tool_result` and `tool_decision` records name neither
    // the agent nor its type, only the call, whose owner the subagent's own
    // hook already named.
    const toolUseId = draft.body["tool_use_id"];
    if (typeof toolUseId === "string") {
      const owner = this.toolCalls.ownerOf(toolUseId);
      const link = owner !== undefined ? this.children.get(owner) : undefined;
      if (link !== undefined) return { target: link.recorder, draft };
    }
    if (draft.standard.agent_name !== undefined) {
      const byType = this.childByType(draft.standard.agent_name, draft.ts);
      if (byType === "ambiguous")
        return {
          target: this,
          draft: {
            ...draft,
            attrs: { ...draft.attrs, [SUBAGENT_TYPE_AMBIGUOUS_ATTR]: "1" },
          },
        };
      if (byType !== undefined) return { target: byType, draft };
    }
    return { target: this, draft };
  }

  /**
   * The sticky standard state a record's `standard` block would produce,
   * computed against the recorder's CURRENT `anthropic`/`context`/`host`/
   * `harnessVersion` without writing to any of them. Pure so a caller can
   * validate or seal against the result before deciding whether the update
   * is ever committed.
   */
  private computeStandardUpdate(
    standard: OtelDraft["standard"],
  ): StandardUpdate {
    const anthropic = compact({
      ...this.anthropic,
      ...standard.anthropic,
    }) as Anthropic;
    const context = compact({
      ...this.context,
      ...compact({ ...standard.context, model: undefined }),
    }) as Context;
    const host = compact({
      ...this.host,
      ...compact({
        os_type: standard.resource.os_type,
        os_version: standard.resource.os_version,
        host_arch: standard.resource.host_arch,
      }),
    }) as Host;
    let harnessVersion = this.harnessVersion;
    if (harnessVersion === undefined)
      harnessVersion = harnessVersionFromExecPath(host.claude_execpath);
    if (standard.resource.harness_version !== undefined)
      harnessVersion = standard.resource.harness_version;
    return { anthropic, context, host, harnessVersion };
  }

  /** Assign a previously computed `StandardUpdate` onto the recorder's sticky state. */
  private commitStandardUpdate(update: StandardUpdate): void {
    this.anthropic = update.anthropic;
    this.context = update.context;
    this.host = update.host;
    this.harnessVersion = update.harnessVersion;
  }

  /**
   * Whether the envelope would refuse the given standard fields, as the
   * message the refusal carries, or undefined when they would seal cleanly.
   * Used by the metrics branch of `ingestOtlp`, which has no `seal()` call to
   * guard it, and by `sealOtelDraft`'s deduped-repeat branch, which also
   * commits with no `seal()` call in the way: both must check a standard
   * update against the same schemas `seal()` would, before it ever reaches
   * the recorder's sticky state.
   */
  private refusedStandardReason(update: StandardUpdate): string | undefined {
    const anthropic = anthropicSchema.safeParse(update.anthropic);
    if (!anthropic.success)
      return anthropic.error.issues[0]?.message ?? "invalid anthropic fields";
    const context = contextSchema.safeParse(update.context);
    if (!context.success)
      return context.error.issues[0]?.message ?? "invalid context fields";
    const host = hostSchema.safeParse(update.host);
    if (!host.success)
      return host.error.issues[0]?.message ?? "invalid host fields";
    const harnessVersion = agentIdentitySchema.shape.harness_version.safeParse(
      update.harnessVersion,
    );
    if (!harnessVersion.success)
      return (
        harnessVersion.error.issues[0]?.message ?? "invalid harness_version"
      );
    return undefined;
  }

  private sealOtelDraft(draft: OtelDraft): TachoEvent | undefined {
    // Computed, not yet assigned: a row the envelope refuses must leave the
    // recorder's `anthropic`/context/host/harnessVersion exactly as they
    // were, so the next record does not inherit a value nothing sealed.
    const standardUpdate = this.computeStandardUpdate(draft.standard);
    // Only the log record takes part: the control plane counts tokens from
    // `otel_log`, never from a span, so a span sealed first must not turn the
    // log record that follows into the duplicate.
    const sighting =
      draft.kind === "llm_call" && draft.source === "otel_log"
        ? this.llmCallSighting(draft.body, draft.source)
        : draft.kind === "tool_call"
          ? // An OTel record names a digest, never bytes, so it never brings
            // a body the chain lacks: a call another source sealed is a
            // repeat whichever OTel record reports it.
            this.toolCallSighting(draft.body, draft.source, false)
          : NO_SIGHTING;
    const duplicate = sighting.attrs;
    if (duplicate === undefined) {
      // No `seal()` call guards this branch either: a dropped repeat whose
      // standard fields the envelope would refuse must not commit them, the
      // same rule `refusedStandardReason` enforces for the metrics branch.
      const refusal = this.refusedStandardReason(standardUpdate);
      if (refusal !== undefined) {
        this.otelRefusals.push(`${draft.kind}: ${refusal}`);
        return undefined;
      }
      sighting.commit();
      this.commitStandardUpdate(standardUpdate);
      return undefined;
    }
    const event = this.seal(
      draft.kind,
      draft.body,
      {
        ts: draft.ts,
        source: draft.source,
        otel_event_name: draft.otel_event_name,
        ...(draft.standard.harness_event_sequence !== undefined
          ? { harness_event_sequence: draft.standard.harness_event_sequence }
          : {}),
        attrs: { ...draft.attrs, ...duplicate },
        ...(draft.span !== undefined ? { span: draft.span } : {}),
        ...(draft.content_digest !== undefined
          ? { content_digest: draft.content_digest }
          : {}),
        raw_source_digest: draft.raw_source_digest,
        turn:
          draft.standard.prompt_id !== undefined
            ? { prompt_id: draft.standard.prompt_id }
            : {},
      },
      standardUpdate,
    );
    // Reached only when `seal()` above did not throw: the row is sealed, so
    // the sticky state its `standard` block computed is safe to commit.
    sighting.commit();
    this.commitStandardUpdate(standardUpdate);
    return event;
  }

  /** Ingest one transcript line (parent transcript or a subagent's). */
  ingestTranscriptLine(line: string, subagentId?: string): TachoEvent[] {
    return this.everySealed(() => this.sealTranscriptLine(line, subagentId));
  }

  private sealTranscriptLine(line: string, subagentId?: string): TachoEvent[] {
    if (subagentId !== undefined && !this.options.parent) {
      const child = this.child(subagentId, undefined, undefined);
      return [
        ...this.pendingChildGenesis.splice(0),
        ...child.ingestTranscriptLine(line),
      ];
    }
    const { drafts, totals, title, interrupted } = normalizeTranscriptLine(
      line,
      this.now(),
    );
    // The title is taken by `sealSessionTitle`, which knows which one wins.
    const { session_title: _title, ...facts } = totals;
    Object.assign(this.totals, facts);
    if (totals.permission_mode !== undefined)
      this.absorbContext({ permission_mode: totals.permission_mode });
    const out: TachoEvent[] =
      title !== undefined ? this.sealSessionTitle(title) : [];
    for (const draft of drafts) {
      this.absorbContext(draft.context);
      let body = draft.body;
      const sighting =
        draft.kind === "llm_call"
          ? this.llmCallSighting(draft.body, "transcript")
          : draft.kind === "tool_call"
            ? this.toolCallSighting(
                draft.body,
                "transcript",
                draft.content !== undefined,
              )
            : NO_SIGHTING;
      let duplicate = sighting.attrs;
      // A tool call the chain already holds seals nothing. A model call the
      // chain already holds is a later content block of one message: its text
      // still ships as a body, its usage does not count again.
      if (duplicate === undefined && draft.kind === "tool_call") {
        sighting.commit();
        continue;
      }
      if (duplicate === undefined) {
        body = withoutUsage(body);
        duplicate = { [LLM_CALL_DUPLICATE_OF_ATTR]: "transcript" };
      }
      out.push(
        this.seal(draft.kind, body, {
          ts: draft.ts,
          source: "transcript",
          attrs: { ...draft.attrs, ...duplicate },
          ...(draft.content !== undefined ? { content: draft.content } : {}),
          raw_source_digest: draft.raw_source_digest,
          turn: draft.turn ?? {},
        }),
      );
      sighting.commit();
    }
    if (interrupted !== undefined) out.push(...this.sealInterrupt(interrupted));
    return out;
  }

  /**
   * Seal the session's title each time it changes. Claude Code generates one
   * (`ai-title`) and rewrites it as the session goes; a name the person gives
   * the session (`custom-title`) outranks it. The text is the frame's
   * content, never a body member, so retention and redaction apply to it as
   * they do to any text the harness wrote.
   */
  private sealSessionTitle(title: {
    text: string;
    source: SessionTitleSource;
  }): TachoEvent[] {
    const current = this.totals.session_title_source;
    if (title.source === "ai-title" && current === "custom-title") return [];
    if (title.text === this.totals.session_title && title.source === current)
      return [];
    const event = this.seal(
      "oxagen:notification",
      { notification_type: "session_title" },
      {
        ts: this.now(),
        source: "transcript",
        hook_source_kind: title.source,
        content: textContent(title.text),
      },
    );
    this.totals.session_title = title.text;
    this.totals.session_title_source = title.source;
    return [event];
  }

  /**
   * Close the turn the person interrupted. Claude Code fires no `Stop` on
   * Esc, so the turn stayed open until the next prompt or the session's end.
   * A record naming another prompt than the open turn's is about a turn
   * already closed: the tailer can read it after the next prompt opened a
   * new one, which must stay open.
   */
  private sealInterrupt(interrupted: {
    ts: string;
    prompt_id?: string;
  }): TachoEvent[] {
    if (!this.turnOpen) return [];
    if (
      interrupted.prompt_id !== undefined &&
      this.promptId !== undefined &&
      interrupted.prompt_id !== this.promptId
    )
      return [];
    const event = this.seal(
      "turn_end",
      {},
      {
        ts: interrupted.ts,
        source: "collector",
        attrs: { [TURN_END_REASON_ATTR]: "interrupted" },
      },
    );
    this.turnOpen = false;
    return [event];
  }

  /** Ingest one record of the `-p` JSON stream (`system.init`, `result`, ...). */
  ingestResultRecord(record: unknown): TachoEvent[] {
    return this.everySealed(() => this.sealResultRecord(record));
  }

  private sealResultRecord(record: unknown): TachoEvent[] {
    const inventory = inventoryFromInit(record);
    if (Object.keys(inventory).length > 0) {
      const { model, permission_mode, session_id: _sid, ...body } = inventory;
      this.absorbContext(compact({ model, permission_mode }));
      if (!this.started) {
        this.started = true;
        return [
          this.seal(
            "agent_start",
            {
              ...body,
              ...(model !== undefined ? { model } : {}),
              session_start_source: "startup",
            },
            { ts: this.now(), source: "result", hook_source_kind: "init" },
          ),
        ];
      }
      return [
        this.seal(
          "oxagen:notification",
          { ...body, notification_type: "init" },
          { ts: this.now(), source: "result", hook_source_kind: "init" },
        ),
      ];
    }
    const totals = totalsFromResult(record);
    if (totals.models.length === 0 && totals.session_id === undefined)
      return [];
    const { models, session_id: _session, queued_turn_count, ...body } = totals;
    Object.assign(
      this.totals,
      compact({
        total_cost_usd_micros: body.total_cost_usd_micros,
        duration_ms: body.duration_ms,
        models_used: body.models_used,
      }),
    );
    return [
      this.seal(
        "agent_stop",
        { ...body, session_outcome: undefined } as Record<string, unknown>,
        {
          ts: this.now(),
          source: "result",
          hook_source_kind: "result",
          attrs: compact({
            "result.queued_turn_count":
              queued_turn_count !== undefined
                ? String(queued_turn_count)
                : undefined,
            "result.models": JSON.stringify(models),
          }) as Record<string, string>,
        },
      ),
    ];
  }

  /** Close the chain if the harness never sent SessionEnd. */
  finalize(
    outcome: "completed" | "aborted" | "crashed" = "crashed",
    at?: string,
  ): TachoEvent[] {
    return this.everySealed(() => this.sealFinal(outcome, at));
  }

  private sealFinal(
    outcome: "completed" | "aborted" | "crashed",
    at?: string,
  ): TachoEvent[] {
    const out: TachoEvent[] = [];
    for (const link of this.children.values()) {
      out.push(...link.recorder.finalize(outcome, at));
    }
    if (this.started && !this.stopped) {
      this.turnOpen = false;
      out.push(
        this.seal(
          "agent_stop",
          {
            session_outcome: outcome,
            unobserved_tail: outcome === "crashed",
            ...this.sessionTotals(),
          },
          {
            ts: at ?? this.now(),
            source: "collector",
          },
        ),
      );
      this.stopped = true;
    }
    return out;
  }

  /**
   * Finalize every subagent chain still open, the way `SubagentStop` does,
   * and mark it closed. The session's own end leaves no subagent running.
   */
  private closeOpenChildren(outcome: "aborted", at: string): TachoEvent[] {
    const out: TachoEvent[] = [];
    for (const link of this.children.values()) {
      if (!link.open) continue;
      out.push(...link.recorder.finalize(outcome, at));
      link.open = false;
      link.closedAt = Date.parse(at);
    }
    return out;
  }

  private sessionTotals(): Partial<BodyOf<"agent_stop">> {
    const t = this.totals;
    return compact({
      total_cost_usd_micros: t.total_cost_usd_micros,
      duration_ms: t.duration_ms,
      api_duration_without_retries_ms: t.api_duration_without_retries_ms,
      tool_duration_ms_total: t.tool_duration_ms_total,
      lines_added: t.lines_added,
      lines_removed: t.lines_removed,
      has_unknown_model_cost: t.has_unknown_model_cost,
      models_used: t.models_used,
      seq_count: this.cursor.seq + 1,
    });
  }

  snapshot(): SessionSnapshot {
    return {
      sessionUuid: this.sessionUuid,
      harnessSessionId: this.harnessSessionId,
      events: [...this.events],
      children: [...this.children.values()].map((link) =>
        link.recorder.snapshot(),
      ),
      totals: { ...this.totals },
      metrics: [...this.metrics],
    };
  }
}

/**
 * The same events with each session's events in seq order. Events keep the
 * slots their session already held, so the order across sessions is kept.
 */
function inChainOrder(events: readonly TachoEvent[]): TachoEvent[] {
  const slots = new Map<string, number[]>();
  events.forEach((event, index) => {
    const taken = slots.get(event.session_uuid) ?? [];
    taken.push(index);
    slots.set(event.session_uuid, taken);
  });
  const out = [...events];
  for (const taken of slots.values()) {
    const ordered = taken
      .map((index) => events[index] as TachoEvent)
      .sort((a, b) => a.seq - b.seq);
    taken.forEach((slot, k) => {
      out[slot] = ordered[k] as TachoEvent;
    });
  }
  return out;
}
