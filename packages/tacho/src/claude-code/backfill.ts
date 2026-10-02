/**
 * Rebuild one Claude Code session's chain from its finished transcript
 * (ADR-161, `docs/specs/tacho/backfill.md` section 2).
 *
 * The live recorder gets a session's frames from two places: the transcript,
 * which `normalizeTranscriptLine` reads, and the hooks, which `normalizeHook`
 * reads. A finished transcript has no hooks left to fire, so this driver
 * derives the hook payloads the transcript implies and feeds them to the same
 * recorder, in the order the hooks would have arrived:
 *
 * | Transcript record | Hook it stands in for | Frame |
 * |---|---|---|
 * | First timed record | `SessionStart` | `agent_start` |
 * | `user` prompt typed by a person | `UserPromptSubmit` | `turn_start` |
 * | `system` `turn_duration`, or the last `assistant` record before the next prompt | `Stop` | `turn_end` |
 * | `tool_use` block | `PreToolUse` | `tool_requested` |
 * | `tool_use` of `Agent` or `Task` joined to a subagent file | `SubagentStart` | `subagent_start` |
 * | The `tool_result` for that call | `SubagentStop` | `subagent_stop` |
 * | `system` `compact_boundary` | `PreCompact` | `oxagen:compaction` |
 * | End of the file | `SessionEnd` | `agent_stop` |
 *
 * Every other frame comes from the transcript line itself, through the
 * recorder's transcript path, exactly as the live tailer seals it.
 *
 * The recorder runs in backfill mode (`RecorderBackfill`), so every frame is
 * marked and deterministic. Each synthesized frame also names the record it
 * came from (`oxagen.synthesized_from`), and its `raw_source_digest` is the
 * digest of that record and the synthesized kind, so two frames made from
 * one record differ.
 *
 * Pure: the caller reads the files and passes lines in. Nothing here reads
 * the disk, the clock, or a random source.
 */
import { digestJcs, type JsonValue } from "../digest";
import type { TachoEvent } from "../envelope";
import type { HookDraft } from "./hooks";
import { countsLlmCallUsage } from "./llm-call-dedupe";
import type { SessionRecorder } from "./recorder";

/**
 * The normalizer version a pass runs under. The cursor file and the server's
 * session heads record it, and a pass does not re-seal a session another
 * version sealed (ADR-161). Raise it whenever a change here or in
 * `transcript.ts` changes a backfilled frame.
 */
export const BACKFILL_NORMALIZER_VERSION = "1";

/**
 * The Claude Code versions with a fixture under
 * `packages/tacho/fixtures/claude-code/`. A session from outside this range is
 * still read, because the mapping keys on field presence and not on version
 * numbers. Its `agent_start` carries `UNTESTED_VERSION_ATTR`, and the report
 * counts it. A new version gets a fixture before the range widens.
 */
const TESTED_CLAUDE_CODE_VERSIONS = {
  lowest: "2.1.263",
  highest: "2.1.281",
} as const;

const UNTESTED_VERSION_ATTR = "oxagen.normalizer_untested_version";
const SYNTHESIZED_FROM_ATTR = "oxagen.synthesized_from";

/** The `session_end_reason` of a backfilled session's `agent_stop`. */
const BACKFILL_END_REASON = "backfill_end_of_file";

/** The `session_start_source` of a backfilled session's `agent_start`. */
const BACKFILL_START_SOURCE = "backfill";

/** Record types the normalizer maps to a frame or to the session's totals. */
const MAPPED_TYPES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "system",
  "permission-mode",
  "worktree-state",
  "relocated",
  "queue-operation",
  "pr-link",
  "ai-title",
  "custom-title",
  "cost-state",
]);

/**
 * Record types the backfill reads, counts by type, and does not map, because
 * the live recorder turns none of them into frames either (spec section 2).
 */
const IGNORED_TYPES: ReadonlySet<string> = new Set([
  "attachment",
  "file-history-snapshot",
  "file-history-delta",
  "mode",
  "agent-setting",
  "agent-name",
  "atis-latch",
  "bridge-session",
  "history-suppression",
  "last-prompt",
  "frame-link",
  "fork-context-ref",
]);

/**
 * The most lines the session's start waits through for a record that names
 * the session's facts. Past it, the start takes what the first timed record
 * has.
 */
const EARLY_LINES = 256;

/** Tool names whose call spawns a subagent. */
const SPAWN_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/** The text Claude Code writes as a user message when the person presses Esc. */
const INTERRUPT_MARKER = "[Request interrupted by user";

/**
 * Markers Claude Code writes at the start of a `user` record's text when the
 * record is a slash command or its output, not a prompt the person typed.
 */
const COMMAND_MARKERS = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
];

/** One subagent transcript the session wrote, and what links it to its spawn. */
export interface BackfillSubagent {
  agentId: string;
  /** `agentType` from the subagent's `meta.json`. */
  agentType?: string;
  /** `toolUseId` from the subagent's `meta.json`. */
  metaToolUseId?: string;
  /** The first `sourceToolUseID` the subagent's own records carry. */
  sourceToolUseId?: string;
}

/** Counts a pass reports. No field holds transcript text. */
export interface BackfillTally {
  lines: number;
  frames: Record<string, number>;
  synthesized: number;
  /** Counted model-call tokens by model and token class. */
  tokens: Record<string, Record<string, number>>;
  recordsIgnored: Record<string, number>;
  drift: {
    unknownTypes: Record<string, number>;
    untestedVersionSessions: number;
  };
  errors: {
    unparseableLines: number;
    /** Lines the envelope refused, each recorded on the chain as a gap. */
    refusedLines: number;
    longLines: number;
    tornTails: number;
    unreadableFiles: number;
  };
  /** Claude Code's own cost figure, from `cost-state`, in micro-dollars. */
  harnessReportedCostMicros: number;
  sessionsWithCostState: number;
}

export function emptyTally(): BackfillTally {
  return {
    lines: 0,
    frames: {},
    synthesized: 0,
    tokens: {},
    recordsIgnored: {},
    drift: { unknownTypes: {}, untestedVersionSessions: 0 },
    errors: {
      unparseableLines: 0,
      refusedLines: 0,
      longLines: 0,
      tornTails: 0,
      unreadableFiles: 0,
    },
    harnessReportedCostMicros: 0,
    sessionsWithCostState: 0,
  };
}

/** Add `from` into `into`, field by field. */
export function addTally(into: BackfillTally, from: BackfillTally): void {
  into.lines += from.lines;
  into.synthesized += from.synthesized;
  addCounts(into.frames, from.frames);
  addCounts(into.recordsIgnored, from.recordsIgnored);
  addCounts(into.drift.unknownTypes, from.drift.unknownTypes);
  into.drift.untestedVersionSessions += from.drift.untestedVersionSessions;
  into.errors.unparseableLines += from.errors.unparseableLines;
  into.errors.refusedLines += from.errors.refusedLines;
  into.errors.longLines += from.errors.longLines;
  into.errors.tornTails += from.errors.tornTails;
  into.errors.unreadableFiles += from.errors.unreadableFiles;
  into.harnessReportedCostMicros += from.harnessReportedCostMicros;
  into.sessionsWithCostState += from.sessionsWithCostState;
  for (const [model, classes] of Object.entries(from.tokens)) {
    const target = (into.tokens[model] ??= {});
    addCounts(target, classes);
  }
}

function addCounts(
  into: Record<string, number>,
  from: Record<string, number>,
): void {
  for (const [key, value] of Object.entries(from))
    into[key] = (into[key] ?? 0) + value;
}

/**
 * The clock the backfill recorder reads. The driver sets it to the last timed
 * record before each line, so a record that carries no timestamp takes the
 * one before it, and nothing reads the wall clock.
 */
export class BackfillClock {
  ms = 0;
  readonly now = (): number => this.ms;
}

interface TranscriptBackfillOptions {
  /** A recorder built with `backfill` set and `context.now` = `clock.now`. */
  recorder: SessionRecorder;
  clock: BackfillClock;
  /** The subagent transcripts beside the session's own. */
  subagents: readonly BackfillSubagent[];
  /**
   * `tool_use_id` to subagent id, from the parent's `toolUseResult.agentId`.
   * The caller reads it from the parent file before the pass, because the
   * result comes after the call it names.
   */
  resultAgentIds: ReadonlyMap<string, string>;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function timestampOf(record: Rec): number | undefined {
  const value = str(record["timestamp"]);
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Compare two dotted version strings numerically, part by part. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10));
  const right = b.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function versionIsTested(version: string): boolean {
  return (
    compareVersions(version, TESTED_CLAUDE_CODE_VERSIONS.lowest) >= 0 &&
    compareVersions(version, TESTED_CLAUDE_CODE_VERSIONS.highest) <= 0
  );
}

/**
 * Whether a `user` record is a prompt a person typed: string content, not
 * marked meta or a compaction summary, and not a slash command, its output,
 * or the interrupt marker.
 */
function isTypedPrompt(record: Rec): string | undefined {
  const message = rec(record["message"]);
  const content = message?.["content"];
  if (typeof content !== "string" || content.length === 0) return undefined;
  if (record["isMeta"] === true || record["isCompactSummary"] === true)
    return undefined;
  const head = content.trimStart();
  if (head.startsWith(INTERRUPT_MARKER)) return undefined;
  if (COMMAND_MARKERS.some((marker) => head.startsWith(marker)))
    return undefined;
  return content;
}

/** The `tool_use` blocks of an assistant record. */
function toolUses(
  record: Rec,
): Array<{ id: string; name: string; input: unknown }> {
  const content = rec(record["message"])?.["content"];
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of content) {
    const item = rec(block);
    if (str(item?.["type"]) !== "tool_use") continue;
    const id = str(item?.["id"]);
    const name = str(item?.["name"]);
    if (id === undefined || name === undefined) continue;
    out.push({ id, name, input: item?.["input"] });
  }
  return out;
}

/** The `tool_result` blocks of a user record, with their error flag. */
function toolResults(record: Rec): Array<{ id: string; isError: boolean }> {
  const content = rec(record["message"])?.["content"];
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; isError: boolean }> = [];
  for (const block of content) {
    const item = rec(block);
    if (str(item?.["type"]) !== "tool_result") continue;
    const id = str(item?.["tool_use_id"]);
    if (id === undefined) continue;
    out.push({ id, isError: item?.["is_error"] === true });
  }
  return out;
}

/**
 * The subagent ids the parent's tool results name, by the `tool_use_id` of
 * the call that spawned each. The caller runs it on every parent line before
 * the pass. Lines that cannot name one are passed over without a parse.
 */
export function resultAgentIdsOf(line: string, into: Map<string, string>): void {
  if (!line.includes('"agentId"') || !line.includes('"toolUseResult"')) return;
  let record: Rec | undefined;
  try {
    record = rec(JSON.parse(line));
  } catch {
    return;
  }
  if (record === undefined || str(record["type"]) !== "user") return;
  const agentId = str(rec(record["toolUseResult"])?.["agentId"]);
  if (agentId === undefined) return;
  for (const result of toolResults(record)) into.set(result.id, agentId);
}

/**
 * The spawning call's id named on a subagent's own record, or undefined. The
 * caller passes the subagent's lines until one answers.
 */
export function sourceToolUseIdOf(line: string): string | undefined {
  if (!line.includes('"sourceToolUseID"')) return undefined;
  try {
    return str(rec(JSON.parse(line))?.["sourceToolUseID"]);
  } catch {
    return undefined;
  }
}

/**
 * The first timed record's instant and the Claude Code version it names, for
 * the `--since` and `--until` filters and the dry run's dates.
 */
export function firstTimedRecordOf(
  line: string,
): { ms: number; version?: string } | undefined {
  if (!line.includes('"timestamp"')) return undefined;
  let record: Rec | undefined;
  try {
    record = rec(JSON.parse(line));
  } catch {
    return undefined;
  }
  if (record === undefined) return undefined;
  const ms = timestampOf(record);
  if (ms === undefined) return undefined;
  const version = str(record["version"]);
  return version !== undefined ? { ms, version } : { ms };
}


/**
 * One session's pass. Feed its lines in file order with `line`, each spawned
 * subagent's lines with `subagentLine` as soon as `line` names it, the
 * subagents no call spawned (`unspawned`) after the last parent line, then
 * `end`.
 *
 * A line the recorder refuses is rolled back whole, so the chain holds no
 * frame of it, and a `telemetry_gap` names its byte offset in its place. The
 * pass goes on.
 */
export class TranscriptBackfill {
  readonly tally: BackfillTally = emptyTally();
  private readonly recorder: SessionRecorder;
  private readonly clock: BackfillClock;
  private readonly sessionId: string;
  /** `tool_use_id` to subagent, in the spec's order of sources. */
  private readonly spawnOf = new Map<string, BackfillSubagent>();
  private readonly subagents = new Map<string, BackfillSubagent>();
  /** Subagents whose `subagent_start` is sealed, by spawning call. */
  private readonly spawned = new Map<string, string>();
  /** Subagents with at least one line fed. */
  private readonly fed = new Set<string>();
  /** Subagents whose `subagent_stop` is sealed. */
  private readonly closed = new Set<string>();
  /** The clock as the parent's own lines left it. */
  private parentMs = 0;
  /**
   * Lines read before the session's start is sealed. The start waits for the
   * first record that carries the session's facts (`cwd`, `gitBranch`,
   * `version`), which is often not the first timed one: a queued prompt or a
   * title can come first.
   */
  private readonly early: Array<{ text: string; record: Rec; offset: number }> =
    [];
  /** The first timed record, whose time `agent_start` takes. */
  private firstTimed: Rec | undefined;
  private started = false;
  private ended = false;
  private lastCostMicros: number | undefined;
  /** The open turn's last model reply: when it came, and why it stopped. */
  private lastReply:
    | { ms: number; stopReason?: string; digest: string; uuid?: string }
    | undefined;

  constructor(options: TranscriptBackfillOptions) {
    this.recorder = options.recorder;
    this.clock = options.clock;
    this.sessionId = options.recorder.harnessSessionId;
    for (const subagent of options.subagents)
      this.subagents.set(subagent.agentId, subagent);
    // The spec's order: the parent's tool result, then `meta.json`, then the
    // subagent's own records. A later source never overrides an earlier one,
    // and one subagent links to one call.
    const linked = new Set<string>();
    for (const [toolUseId, agentId] of options.resultAgentIds) {
      const subagent = this.subagents.get(agentId);
      if (subagent === undefined || linked.has(agentId)) continue;
      if (this.spawnOf.has(toolUseId)) continue;
      this.spawnOf.set(toolUseId, subagent);
      linked.add(agentId);
    }
    for (const pick of ["metaToolUseId", "sourceToolUseId"] as const) {
      for (const subagent of options.subagents) {
        const toolUseId = subagent[pick];
        if (toolUseId === undefined || linked.has(subagent.agentId)) continue;
        if (this.spawnOf.has(toolUseId)) continue;
        this.spawnOf.set(toolUseId, subagent);
        linked.add(subagent.agentId);
      }
    }
  }

  /** Whether the session had a timed record, and so a chain. */
  get hasChain(): boolean {
    return this.started;
  }

  /**
   * One line of the session's own transcript. Answers the frames sealed and
   * the subagents a call in it spawned, whose transcripts the caller feeds
   * next. `offset` is the line's byte offset, which a gap frame names.
   */
  line(
    text: string,
    offset: number,
  ): { events: TachoEvent[]; spawn: string[] } {
    this.clock.ms = this.parentMs;
    const parsed = this.parse(text);
    if (parsed === "unparseable")
      return {
        events: this.gapOrNothing("transcript_line_unparseable", offset),
        spawn: [],
      };
    if (parsed === undefined) return { events: [], spawn: [] };
    if (!this.started) {
      if (this.firstTimed === undefined && timestampOf(parsed) !== undefined)
        this.firstTimed = parsed;
      this.early.push({ text, record: parsed, offset });
      const ready =
        this.firstTimed !== undefined &&
        (str(parsed["cwd"]) !== undefined || this.early.length >= EARLY_LINES);
      return ready ? this.begin() : { events: [], spawn: [] };
    }
    const ms = timestampOf(parsed);
    if (ms !== undefined) {
      this.parentMs = ms;
      this.clock.ms = ms;
    }
    const spawn: string[] = [];
    return { events: this.mappedLine(parsed, text, offset, spawn), spawn };
  }

  /**
   * Begin a session still waiting for its facts once its last line is read:
   * a file whose records never named a `cwd`. Answers nothing for a session
   * already begun, or one with no timed record, which has no chain.
   */
  finishParent(): { events: TachoEvent[]; spawn: string[] } {
    if (this.started || this.firstTimed === undefined)
      return { events: [], spawn: [] };
    return this.begin();
  }

  /**
   * Seal the session's start, then the lines read while it waited. The start
   * takes the first timed record's time, the facts of the first record that
   * names a `cwd`, and the first permission mode the file records.
   */
  private begin(): { events: TachoEvent[]; spawn: string[] } {
    const first = this.firstTimed as Rec;
    const early = this.early.splice(0);
    const facts =
      early.find((item) => str(item.record["cwd"]) !== undefined)?.record ??
      first;
    const permissionMode =
      str(facts["permissionMode"]) ??
      early
        .map((item) => item.record)
        .filter((record) => str(record["type"]) === "permission-mode")
        .map((record) => str(record["permissionMode"]))
        .find((mode) => mode !== undefined);
    this.parentMs = timestampOf(first) ?? 0;
    this.clock.ms = this.parentMs;
    // The start is not guarded: a chain whose `agent_start` the envelope
    // refused has nothing to put a gap on, and the caller fails the session.
    const events = this.collect(this.start(first, facts, permissionMode));
    const spawn: string[] = [];
    for (const item of early) {
      const ms = timestampOf(item.record);
      if (ms !== undefined) this.parentMs = Math.max(this.parentMs, ms);
      this.clock.ms = ms ?? this.parentMs;
      events.push(...this.mappedLine(item.record, item.text, item.offset, spawn));
    }
    this.clock.ms = this.parentMs;
    return { events, spawn };
  }

  /** One parent line through the mapping, guarded. */
  private mappedLine(
    record: Rec,
    text: string,
    offset: number,
    spawn: string[],
  ): TachoEvent[] {
    const spawnedBefore = new Set(this.spawned.keys());
    const spawnLength = spawn.length;
    return this.guarded(
      offset,
      undefined,
      () => this.mapped(record, text, spawn),
      () => {
        // A refused line spawned nothing: its `subagent_start` is undone.
        spawn.length = spawnLength;
        for (const toolUseId of [...this.spawned.keys()])
          if (!spawnedBefore.has(toolUseId)) this.spawned.delete(toolUseId);
      },
    );
  }

  /** One line of a subagent's transcript, sealed on that subagent's chain. */
  subagentLine(agentId: string, text: string, offset: number): TachoEvent[] {
    if (!this.started) return [];
    const parsed = this.parse(text);
    if (parsed === "unparseable")
      return this.gapOrNothing("transcript_line_unparseable", offset, agentId);
    if (parsed === undefined) return [];
    const ms = timestampOf(parsed);
    if (ms !== undefined) this.clock.ms = ms;
    this.fed.add(agentId);
    const subagent = this.subagents.get(agentId);
    return this.guarded(offset, agentId, () => {
      const out = this.recorder.ingestTranscriptLine(text, agentId);
      if (str(parsed["type"]) !== "assistant") return out;
      for (const use of toolUses(parsed)) {
        out.push(
          ...this.hook(
            parsed,
            "PreToolUse",
            {
              agent_id: agentId,
              ...(subagent?.agentType !== undefined
                ? { agent_type: subagent.agentType }
                : {}),
              tool_name: use.name,
              tool_input: use.input,
              tool_use_id: use.id,
            },
            ms,
          ),
        );
      }
      return out;
    });
  }

  /**
   * A line longer than the reader takes. It is counted and recorded on the
   * chain as a gap, as an unparseable line is (spec section 8).
   */
  longLine(offset: number, agentId?: string): TachoEvent[] {
    this.tally.lines += 1;
    this.tally.errors.longLines += 1;
    return this.gapOrNothing("transcript_line_too_long", offset, agentId);
  }

  /**
   * The subagents no call in the parent spawned. They keep their parent link,
   * and their `spawn_tool_use_id` stays unset (spec section 2). The caller
   * feeds each after the parent's last line.
   */
  unspawned(): string[] {
    const spawned = new Set(this.spawned.values());
    return [...this.subagents.keys()].filter((id) => !spawned.has(id));
  }

  /**
   * Close the session at the end of its file: the open turn, each subagent
   * fed but never stopped, then `agent_stop` with
   * `session_end_reason = backfill_end_of_file`. Answers nothing for a file
   * with no timed record, which has no chain to close.
   */
  end(): TachoEvent[] {
    if (!this.started || this.ended) return [];
    this.ended = true;
    this.clock.ms = this.parentMs;
    const events = this.closeTurn();
    for (const agentId of [...this.fed].sort()) {
      if (this.closed.has(agentId)) continue;
      this.closed.add(agentId);
      const subagent = this.subagents.get(agentId);
      events.push(
        ...this.hook(
          undefined,
          "SubagentStop",
          {
            agent_id: agentId,
            ...(subagent?.agentType !== undefined
              ? { agent_type: subagent.agentType }
              : {}),
          },
          this.parentMs,
        ),
      );
    }
    events.push(
      ...this.hook(
        undefined,
        "SessionEnd",
        { reason: BACKFILL_END_REASON },
        this.parentMs,
        (draft) => ({
          ...draft,
          // Nothing watched the session end, so its outcome is not known.
          body: { ...draft.body, session_outcome: "unknown" },
        }),
      ),
    );
    if (this.lastCostMicros !== undefined) {
      this.tally.harnessReportedCostMicros += this.lastCostMicros;
      this.tally.sessionsWithCostState += 1;
    }
    return this.collect(events);
  }

  /**
   * The record a line holds when the backfill maps it; undefined for a blank
   * line, a type it only counts, or a type it does not know; or
   * `"unparseable"`.
   */
  private parse(text: string): Rec | "unparseable" | undefined {
    const trimmed = text.trim();
    if (trimmed === "") return undefined;
    this.tally.lines += 1;
    let value: Rec | undefined;
    try {
      value = rec(JSON.parse(trimmed));
    } catch {
      value = undefined;
    }
    if (value === undefined) {
      this.tally.errors.unparseableLines += 1;
      return "unparseable";
    }
    const type = str(value["type"]);
    if (type === undefined) {
      count(this.tally.drift.unknownTypes, "(none)");
      return undefined;
    }
    if (IGNORED_TYPES.has(type) || type.startsWith("artifact-")) {
      count(this.tally.recordsIgnored, type);
      return undefined;
    }
    if (!MAPPED_TYPES.has(type)) {
      count(this.tally.drift.unknownTypes, type);
      return undefined;
    }
    if (type === "cost-state") {
      // Each one is the session's running total, so the last one counts.
      const cost = value["totalCostUSD"];
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0)
        this.lastCostMicros = Math.round(cost * 1_000_000);
    }
    return value;
  }

  /**
   * Run one line's seals. A seal the recorder refuses rolls back every frame
   * the line sealed, on this chain and its subagents', and a gap stands in
   * for the line.
   */
  private guarded(
    offset: number,
    agentId: string | undefined,
    run: () => TachoEvent[],
    undo?: () => void,
  ): TachoEvent[] {
    const mark = this.recorder.markChain();
    try {
      return this.collect(run());
    } catch {
      this.recorder.rollbackChain(mark);
      undo?.();
      this.tally.errors.refusedLines += 1;
      return this.gapOrNothing("transcript_line_refused", offset, agentId);
    }
  }

  /** A gap frame for one line, or nothing before the chain has begun. */
  private gapOrNothing(
    reason: string,
    offset: number,
    agentId?: string,
  ): TachoEvent[] {
    // A gap needs a chain to sit on. A line before the first timed record is
    // counted and has none yet.
    if (!this.started) return [];
    return this.collect([
      this.recorder.sealCollectorEvent(
        "telemetry_gap",
        { gap_dropped_count: 1 },
        {
          attrs: {
            "gap.reason": reason,
            "gap.detail": `byte offset ${offset}`,
            ...(agentId !== undefined ? { "gap.subagent_id": agentId } : {}),
          },
        },
      ),
    ]);
  }

  private start(
    first: Rec,
    facts: Rec,
    permissionMode: string | undefined,
  ): TachoEvent[] {
    this.started = true;
    const version = str(facts["version"]);
    const untested = version !== undefined && !versionIsTested(version);
    if (untested) this.tally.drift.untestedVersionSessions += 1;
    // The facts the first record holds reach `agent_start` through the
    // recorder's sticky context, the way a live session's reach it before
    // its `SessionStart` is sealed.
    this.recorder.noteContext(
      compactFacts({
        cwd: str(facts["cwd"]),
        git_branch: str(facts["gitBranch"]),
        app_version: version,
        entrypoint: str(facts["entrypoint"]),
        session_kind: str(facts["sessionKind"]),
        permission_mode: permissionMode,
      }) as Parameters<SessionRecorder["noteContext"]>[0],
    );
    return this.hook(
      first,
      "SessionStart",
      { source: BACKFILL_START_SOURCE },
      timestampOf(first),
      untested && version !== undefined
        ? (draft) => ({
            ...draft,
            attrs: { ...draft.attrs, [UNTESTED_VERSION_ATTR]: version },
          })
        : undefined,
    );
  }

  private mapped(record: Rec, text: string, spawn: string[]): TachoEvent[] {
    const type = str(record["type"]);
    const ms = timestampOf(record);
    const events: TachoEvent[] = [];
    if (type === "user") {
      const prompt = isTypedPrompt(record);
      if (prompt !== undefined) {
        events.push(...this.closeTurn());
        events.push(
          ...this.hook(
            record,
            "UserPromptSubmit",
            {
              prompt,
              ...(str(record["promptId"]) !== undefined
                ? { prompt_id: str(record["promptId"]) }
                : {}),
              ...(str(record["permissionMode"]) !== undefined
                ? { permission_mode: str(record["permissionMode"]) }
                : {}),
            },
            ms,
          ),
        );
      }
      // A subagent's spawning call returns here. Its `SubagentStop` comes
      // before the call's own result, as the hooks arrive live.
      for (const result of toolResults(record)) {
        const agentId = this.spawned.get(result.id);
        if (agentId === undefined || this.closed.has(agentId)) continue;
        this.closed.add(agentId);
        const subagent = this.subagents.get(agentId);
        events.push(
          ...this.hook(
            record,
            "SubagentStop",
            {
              agent_id: agentId,
              ...(subagent?.agentType !== undefined
                ? { agent_type: subagent.agentType }
                : {}),
            },
            ms,
            (draft) => ({
              ...draft,
              body: {
                ...draft.body,
                tool_use_id: result.id,
                tool_status: result.isError ? "error" : "ok",
              },
            }),
          ),
        );
      }
      events.push(...this.recorder.ingestTranscriptLine(text));
      return events;
    }
    if (type === "system") {
      const subtype = str(record["subtype"]);
      if (subtype === "turn_duration" && this.recorder.turnIsOpen) {
        const duration = nonNegative(record["durationMs"]);
        const reply = this.lastReply;
        this.lastReply = undefined;
        events.push(
          ...this.hook(record, "Stop", {}, ms, (draft) => ({
            ...draft,
            body: {
              ...draft.body,
              ...(duration !== undefined ? { turn_duration_ms: duration } : {}),
              ...(reply?.stopReason !== undefined
                ? { stop_reason: reply.stopReason }
                : {}),
            },
          })),
        );
      }
      if (subtype === "compact_boundary") {
        const meta = rec(record["compactMetadata"]);
        const before = nonNegative(meta?.["preTokens"]);
        const after = nonNegative(meta?.["postTokens"]);
        const trigger = str(meta?.["trigger"]);
        events.push(
          ...this.hook(
            record,
            "PreCompact",
            trigger !== undefined ? { trigger } : {},
            ms,
            (draft) => ({
              ...draft,
              body: {
                ...draft.body,
                ...(before !== undefined ? { tokens_before: before } : {}),
                ...(after !== undefined ? { tokens_after: after } : {}),
              },
            }),
          ),
        );
      }
      events.push(...this.recorder.ingestTranscriptLine(text));
      return events;
    }
    events.push(...this.recorder.ingestTranscriptLine(text));
    if (type !== "assistant") return events;
    const message = rec(record["message"]);
    if (this.recorder.turnIsOpen && ms !== undefined) {
      const stopReason = str(message?.["stop_reason"]);
      const uuid = str(record["uuid"]);
      this.lastReply = {
        ms,
        ...(stopReason !== undefined ? { stopReason } : {}),
        digest: digestJcs(record as JsonValue),
        ...(uuid !== undefined ? { uuid } : {}),
      };
    }
    for (const use of toolUses(record)) {
      events.push(
        ...this.hook(
          record,
          "PreToolUse",
          { tool_name: use.name, tool_input: use.input, tool_use_id: use.id },
          ms,
        ),
      );
      if (!SPAWN_TOOLS.has(use.name)) continue;
      const subagent = this.spawnOf.get(use.id);
      if (subagent === undefined || this.spawned.has(use.id)) continue;
      this.spawned.set(use.id, subagent.agentId);
      events.push(
        ...this.hook(
          record,
          "SubagentStart",
          {
            agent_id: subagent.agentId,
            ...(subagent.agentType !== undefined
              ? { agent_type: subagent.agentType }
              : {}),
            tool_use_id: use.id,
          },
          ms,
        ),
      );
      spawn.push(subagent.agentId);
    }
    return events;
  }

  /**
   * The `turn_end` of a turn the transcript left open: no `turn_duration`
   * record closed it before the next prompt or the end of the file. It is
   * sealed at the turn's last model reply, with that reply's stop reason.
   */
  private closeTurn(): TachoEvent[] {
    if (!this.recorder.turnIsOpen) return [];
    const reply = this.lastReply;
    this.lastReply = undefined;
    const ms = reply?.ms ?? this.clock.ms;
    const saved = this.clock.ms;
    this.clock.ms = ms;
    try {
      return this.hook(undefined, "Stop", {}, ms, (draft) => ({
        ...draft,
        ...(reply !== undefined
          ? {
              raw_source_digest: synthesizedDigest(reply.digest, draft.kind),
              attrs: {
                ...draft.attrs,
                [SYNTHESIZED_FROM_ATTR]:
                  reply.uuid !== undefined
                    ? `assistant:${reply.uuid}`
                    : "assistant",
              },
            }
          : {}),
        body: {
          ...draft.body,
          ...(reply?.stopReason !== undefined
            ? { stop_reason: reply.stopReason }
            : {}),
        },
      }));
    } finally {
      this.clock.ms = saved;
    }
  }

  /**
   * Seal the frames one synthesized hook payload stands for. `record` is the
   * transcript record it came from, or undefined for the end of the file.
   */
  private hook(
    record: Rec | undefined,
    hookEventName: string,
    fields: Record<string, unknown>,
    ms: number | undefined,
    rewrite?: (draft: HookDraft) => HookDraft,
  ): TachoEvent[] {
    const seed =
      record !== undefined
        ? digestJcs(record as JsonValue)
        : digestJcs({
            end_of_file: this.sessionId,
            hook: hookEventName,
            agent: str(fields["agent_id"]) ?? null,
          });
    const from =
      record === undefined
        ? "end_of_file"
        : recordName(record);
    return this.recorder.ingestHook(
      { session_id: this.sessionId, hook_event_name: hookEventName, ...fields },
      {},
      new Date(ms ?? this.clock.ms).toISOString(),
      (draft) => {
        const marked: HookDraft = {
          ...draft,
          raw_source_digest: synthesizedDigest(seed, draft.kind),
          attrs: { ...draft.attrs, [SYNTHESIZED_FROM_ATTR]: from },
        };
        return rewrite !== undefined ? rewrite(marked) : marked;
      },
    );
  }

  /** Count what was sealed: frames by kind, and counted tokens by model. */
  private collect(events: TachoEvent[]): TachoEvent[] {
    for (const event of events) {
      count(this.tally.frames, event.kind);
      if (event.attrs[SYNTHESIZED_FROM_ATTR] !== undefined)
        this.tally.synthesized += 1;
      if (!countsLlmCallUsage(event)) continue;
      const body = event.body as Record<string, unknown>;
      const model = str(body["model"]) ?? "unknown";
      const classes = (this.tally.tokens[model] ??= {});
      for (const key of TOKEN_CLASSES) {
        const value = nonNegative(body[key]);
        if (value !== undefined) classes[key] = (classes[key] ?? 0) + value;
      }
    }
    return events;
  }
}

/** The token classes the report sums, as an `llm_call` body names them. */
const TOKEN_CLASSES = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "thinking_tokens",
] as const;

/** How `oxagen.synthesized_from` names a record: type, subtype, and uuid. */
function recordName(record: Rec): string {
  const type = str(record["type"]) ?? "record";
  const subtype = str(record["subtype"]);
  const uuid = str(record["uuid"]);
  return `${type}${subtype !== undefined ? `/${subtype}` : ""}${
    uuid !== undefined ? `:${uuid}` : ""
  }`;
}

function count(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

/** The digest a synthesized frame carries: its record's, and its kind. */
function synthesizedDigest(
  recordDigest: string,
  kind: string,
): `sha256:${string}` {
  return digestJcs({ record: recordDigest, synthesized: kind });
}

function compactFacts(
  facts: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(facts))
    if (value !== undefined) out[key] = value;
  return out;
}
