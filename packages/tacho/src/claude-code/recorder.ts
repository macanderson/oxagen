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
import { type ChainCursor, GENESIS_CURSOR, sealEvent } from "../chain";
import type {
  BodyOf,
  TachoEvent,
  TachoKind,
  UnsealedTachoEvent,
} from "../envelope";
import { newEventId, sessionUuid } from "../ids";
import { toProtocolTimestamp } from "../timestamp";
import {
  type ClaudeCodeContext,
  DEFAULT_SECRET_ENV_PATTERN,
  harnessVersionFromExecPath,
  snapshotEnv,
} from "./context";
import { type HookDraft, normalizeHook } from "./hooks";
import {
  type OtelDraft,
  type OtelMetricPoint,
  normalizeOtlp,
  type OtlpPayload,
} from "./otel";
import { inventoryFromInit, totalsFromResult } from "./result";
import { normalizeTranscriptLine, type TranscriptTotals } from "./transcript";

type Context = NonNullable<TachoEvent["context"]>;
type Host = NonNullable<TachoEvent["host"]>;
type Anthropic = NonNullable<TachoEvent["anthropic"]>;

export interface RecorderOptions {
  context: ClaudeCodeContext;
  /** The harness's own session id (Claude Code's UUID). */
  harnessSessionId: string;
  /** Host enrollment id (Claude Code hosts) or agent key (SDK agents). */
  scope: string;
  parent?: {
    sessionUuid: string;
    rootSessionUuid: string;
    subagentId: string;
    subagentType?: string;
    spawnToolUseId?: string;
    spawnDepth: number;
  };
}

interface SubagentLink {
  recorder: SessionRecorder;
  type?: string;
  open: boolean;
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

export class SessionRecorder {
  readonly sessionUuid: string;
  readonly rootSessionUuid: string;
  readonly harnessSessionId: string;
  private readonly options: RecorderOptions;
  private cursor: ChainCursor = GENESIS_CURSOR;
  private readonly events: TachoEvent[] = [];
  private readonly children = new Map<string, SubagentLink>();
  /** Genesis events sealed by child creation, drained by the ingest that caused it. */
  private pendingChildGenesis: TachoEvent[] = [];
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

  constructor(options: RecorderOptions) {
    this.options = options;
    this.harnessSessionId = options.harnessSessionId;
    this.sessionUuid = options.parent
      ? sessionUuid(
          options.scope,
          `${options.harnessSessionId}/agent/${options.parent.subagentId}`,
        )
      : sessionUuid(options.scope, options.harnessSessionId);
    this.rootSessionUuid = options.parent?.rootSessionUuid ?? this.sessionUuid;
    this.harnessVersion = options.context.agent.harness_version;
    if (options.context.host) this.host = { ...options.context.host };
  }

  get hasStarted(): boolean {
    return this.started;
  }

  get hasStopped(): boolean {
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

  private childByType(type: string): SessionRecorder | undefined {
    let candidate: SubagentLink | undefined;
    for (const link of this.children.values()) {
      if (link.type === type && link.open) candidate = link;
    }
    return candidate?.recorder;
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
      span?: TachoEvent["span"];
      content_digest?: `sha256:${string}`;
      raw_source_digest?: `sha256:${string}`;
      turn?: { prompt_id?: string; turn_id?: string };
    },
  ): TachoEvent {
    const parent = this.options.parent;
    const unsealed = compact({
      v: "tacho/1.0",
      event_id: newEventId(Date.parse(fields.ts)),
      session_id: this.harnessSessionId,
      session_uuid: this.sessionUuid,
      root_session_uuid: this.rootSessionUuid,
      parent_session_uuid: parent?.sessionUuid,
      ts: fields.ts,
      fidelity: "sdk",
      source: fields.source,
      hook_event_name: fields.hook_event_name,
      hook_source_kind: fields.hook_source_kind,
      otel_event_name: fields.otel_event_name,
      harness_event_sequence: fields.harness_event_sequence,
      agent: compact({
        ...this.options.context.agent,
        harness_version: this.harnessVersion,
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
      context:
        Object.keys(this.context).length > 0 ? { ...this.context } : undefined,
      host: Object.keys(this.host).length > 0 ? { ...this.host } : undefined,
      anthropic:
        Object.keys(this.anthropic).length > 0
          ? { ...this.anthropic }
          : undefined,
      span: fields.span,
      attrs: fields.attrs ?? {},
      content:
        fields.content_digest !== undefined
          ? { digest: fields.content_digest, redactions: [] }
          : undefined,
      raw_source_digest: fields.raw_source_digest,
      kind,
      body,
    }) as unknown as UnsealedTachoEvent;
    const sealed = sealEvent(unsealed, this.cursor);
    this.cursor = sealed.next;
    this.events.push(sealed.event);
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

  /** Ingest one hook payload with the hook process environment. */
  ingestHook(
    raw: unknown,
    env: Record<string, string | undefined>,
    at?: string,
  ): TachoEvent[] {
    const drafts = normalizeHook(raw, env, { sessionUuid: this.sessionUuid });
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
      out.push(...child.ingestHook(raw, env, ts));
      if (first.hook_event_name === "SubagentStop") {
        out.push(...child.finalize("completed", ts));
        const link = this.children.get(subagentId);
        if (link) link.open = false;
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
      out.push(this.sealHookDraft(draft, env, ts));
    }
    return out;
  }

  private sealHookDraft(
    draft: HookDraft,
    env: Record<string, string | undefined>,
    ts: string,
  ): TachoEvent {
    this.absorbContext(draft.context);
    this.absorbHost(draft.host);
    if (this.envSnapshot === undefined) {
      this.envSnapshot = snapshotEnv(
        env,
        this.options.context.secretEnvPattern ?? DEFAULT_SECRET_ENV_PATTERN,
      );
    }
    let body = draft.body;
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
      body = { ...body, env_snapshot: this.envSnapshot };
    }
    if (draft.kind === "turn_start") {
      if (this.turnOpen) {
        this.seal(
          "turn_end",
          {},
          { ts, source: "collector", hook_event_name: "UserPromptSubmit" },
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
    const event = this.seal(draft.kind, body, {
      ts,
      source: "hook",
      hook_event_name: draft.hook_event_name,
      ...(draft.hook_source_kind !== undefined
        ? { hook_source_kind: draft.hook_source_kind }
        : {}),
      attrs: draft.attrs,
      ...(draft.content_digest !== undefined
        ? { content_digest: draft.content_digest }
        : {}),
      raw_source_digest: draft.raw_source_digest,
      turn: draft.turn ?? {},
    });
    if (draft.kind === "turn_end") {
      this.turnOpen = false;
    }
    if (draft.kind === "agent_stop") {
      this.stopped = true;
      this.turnOpen = false;
    }
    return event;
  }

  /** Ingest one OTLP/HTTP JSON payload. Records for other sessions are ignored. */
  ingestOtlp(payload: OtlpPayload): TachoEvent[] {
    const { drafts, metrics } = normalizeOtlp(payload);
    const out: TachoEvent[] = [];
    for (const metric of metrics) {
      if (
        metric.standard.session_id !== undefined &&
        metric.standard.session_id !== this.harnessSessionId
      )
        continue;
      this.absorbStandard(metric.standard);
      this.metrics.push(metric);
    }
    for (const draft of drafts) {
      if (
        draft.standard.session_id !== undefined &&
        draft.standard.session_id !== this.harnessSessionId
      )
        continue;
      const target = this.routeOtel(draft);
      out.push(...this.pendingChildGenesis.splice(0));
      out.push(target.sealOtelDraft(draft));
    }
    return out;
  }

  private routeOtel(draft: OtelDraft): SessionRecorder {
    if (this.options.parent) return this;
    if (draft.standard.agent_id !== undefined) {
      return this.child(
        draft.standard.agent_id,
        draft.standard.agent_name,
        undefined,
        draft.ts,
      );
    }
    if (draft.standard.agent_name !== undefined) {
      const byType = this.childByType(draft.standard.agent_name);
      if (byType) return byType;
    }
    return this;
  }

  private absorbStandard(standard: OtelDraft["standard"]): void {
    this.anthropic = compact({
      ...this.anthropic,
      ...standard.anthropic,
    }) as Anthropic;
    this.absorbContext(compact({ ...standard.context, model: undefined }));
    this.absorbHost(
      compact({
        os_type: standard.resource.os_type,
        os_version: standard.resource.os_version,
        host_arch: standard.resource.host_arch,
      }),
    );
    if (standard.resource.harness_version !== undefined)
      this.harnessVersion = standard.resource.harness_version;
  }

  private sealOtelDraft(draft: OtelDraft): TachoEvent {
    this.absorbStandard(draft.standard);
    return this.seal(draft.kind, draft.body, {
      ts: draft.ts,
      source: draft.source,
      otel_event_name: draft.otel_event_name,
      ...(draft.standard.harness_event_sequence !== undefined
        ? { harness_event_sequence: draft.standard.harness_event_sequence }
        : {}),
      attrs: draft.attrs,
      ...(draft.span !== undefined ? { span: draft.span } : {}),
      ...(draft.content_digest !== undefined
        ? { content_digest: draft.content_digest }
        : {}),
      raw_source_digest: draft.raw_source_digest,
      turn:
        draft.standard.prompt_id !== undefined
          ? { prompt_id: draft.standard.prompt_id }
          : {},
    });
  }

  /** Ingest one transcript line (parent transcript or a subagent's). */
  ingestTranscriptLine(line: string, subagentId?: string): TachoEvent[] {
    if (subagentId !== undefined && !this.options.parent) {
      const child = this.child(subagentId, undefined, undefined);
      return [
        ...this.pendingChildGenesis.splice(0),
        ...child.ingestTranscriptLine(line),
      ];
    }
    const { drafts, totals } = normalizeTranscriptLine(line, this.now());
    Object.assign(this.totals, totals);
    if (totals.permission_mode !== undefined)
      this.absorbContext({ permission_mode: totals.permission_mode });
    const out: TachoEvent[] = [];
    for (const draft of drafts) {
      this.absorbContext(draft.context);
      out.push(
        this.seal(draft.kind, draft.body, {
          ts: draft.ts,
          source: "transcript",
          attrs: draft.attrs,
          raw_source_digest: draft.raw_source_digest,
          turn: draft.turn ?? {},
        }),
      );
    }
    return out;
  }

  /** Ingest one record of the `-p` JSON stream (`system.init`, `result`, ...). */
  ingestResultRecord(record: unknown): TachoEvent[] {
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
    const out: TachoEvent[] = [];
    for (const link of this.children.values()) {
      out.push(...link.recorder.finalize(outcome, at));
    }
    if (this.started && !this.stopped) {
      this.stopped = true;
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
