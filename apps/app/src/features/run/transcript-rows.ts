// The Transcript tab's rows, drawn from the entries `get_run_transcript`
// answers at `steps` (mockup `txEntries` and `txRow`): the operator's prompt,
// the model's words and thinking, each tool call as one row, what each model
// step cost, what was recalled, and the run's stop.
//
// The server is the only place a run's transcript is folded (ADR-182). It
// pairs the halves of each call, gathers every frame of one call into one
// entry, nests a subagent's entries under the call that spawned them, and
// states each entry's outcome, gates, subject, family, duration and recall,
// whether it has anything to show, and which `tool_use` block a tool entry
// already draws. This module folds nothing. `rowsOf` reads one entry into
// the rows it draws, and every fact on a row is a field of that entry or of
// one of its halves.
//
// Pure, so every row is tested without a render. A figure the entry did not
// carry is left out rather than drawn as a zero.
import type { Cost } from "@/data/contracts/money";
import {
  TRANSCRIPT_KINDS,
  type TranscriptBody,
  type TranscriptEntry,
  type TranscriptKind,
  type TranscriptRecall,
  type TranscriptUsage,
} from "@/data/contracts/run";
import {
  callDetail,
  parseBody,
  type ToolDetail,
  type ToolDiff,
  type ToolGroup,
  toolDetailOf,
} from "./tool-detail";

/**
 * The one half of the exchange an entry carries, or null.
 *
 * A prompt, a reply, a recall and a manifest are each one frame, so exactly
 * one half is recorded: what went out, or what came back. This answers that
 * half.
 *
 * An entry carrying BOTH halves answers null rather than picking one. That is
 * the whole point of the function. A tool step carries its input in `request`
 * and its result in `response`; a positional `response ?? request` would
 * silently render a tool's input where its result belongs, and nothing about
 * the page would look wrong. A caller that needs both halves reads them by
 * name, which is what the tool reading does (`callDetail`).
 */
export function soleBody(entry: TranscriptEntry): TranscriptBody | null {
  if (entry.request !== null && entry.response !== null) return null;
  return entry.response ?? entry.request;
}

/**
 * An entry's name within its run, as the server names it: stable across
 * re-reads, so it keys a rendered list and merges a later page.
 */
export function entryKey(entry: TranscriptEntry): string {
  return entry.key;
}

/** A transcript with at least one entry: the only kind the view draws. */
export type Frames = readonly [TranscriptEntry, ...TranscriptEntry[]];

export function isNonEmpty(
  entries: readonly TranscriptEntry[],
): entries is Frames {
  return entries.length > 0;
}

/**
 * `page` merged into `held` by each entry's key: an entry the reader already
 * holds is replaced where it stands, and a new one is appended in the order
 * the page sent it.
 *
 * `get_run_transcript` sends an entry again when it has grown since it was
 * sent: a step that gained its result, a turn that gained a step, a Task call
 * whose subagent recorded more (#4048). The grown copy is the one to show,
 * and appending it drew the same step twice. Replacing in place keeps the
 * row where the reader saw it, and keeps the last entry the run's latest.
 */
export function mergeEntries(
  held: Frames,
  page: readonly TranscriptEntry[],
): Frames;
export function mergeEntries(
  held: readonly TranscriptEntry[],
  page: readonly TranscriptEntry[],
): TranscriptEntry[];
export function mergeEntries(
  held: readonly TranscriptEntry[],
  page: readonly TranscriptEntry[],
): readonly TranscriptEntry[] {
  const out = [...held];
  const at = new Map(out.map((entry, index) => [entryKey(entry), index]));
  for (const entry of page) {
    const key = entryKey(entry);
    const index = at.get(key);
    if (index === undefined) {
      at.set(key, out.length);
      out.push(entry);
    } else out[index] = entry;
  }
  return out;
}

/**
 * A fresh read of the whole run laid over what a reader holds: the fresh
 * read's entries in the fresh read's order, then each held entry it does not
 * carry, which a reader paged in past that read's bound.
 *
 * `mergeEntries` appends what is new, which is right for a tail page and
 * wrong here. A subagent frame recorded late is placed by the server after
 * the call that spawned it, before entries the reader already holds (#4083).
 * Appended, it would draw at the foot of the run, away from its call.
 */
export function rebaseEntries(
  fresh: Frames,
  held: readonly TranscriptEntry[],
): Frames {
  const known = new Set(fresh.map(entryKey));
  const past = held.filter((entry) => !known.has(entryKey(entry)));
  return past.length === 0 ? fresh : [...fresh, ...past];
}

// ── The feed ────────────────────────────────────────────────────────────────

/**
 * The Transcript tab's kind chips (mockup `TX_GROUPS`), in the contract's
 * order: every chip `get_run_transcript` counts except `policy`, which is the
 * ⚖ chip on the call a decision was made about, and `errors`, which is the
 * errors toggle beside the chips. Each chip's count is the server's
 * (`counts.kinds`), and the server's chip selects what the chip shows here.
 */
export type FeedGroup = Exclude<TranscriptKind, "policy" | "errors">;
export const FEED_GROUPS: readonly FeedGroup[] = TRANSCRIPT_KINDS.filter(
  (kind): kind is FeedGroup => kind !== "policy" && kind !== "errors",
);

/** A frame a row links to. `chainRef` is set for a subagent's frame, which no link can open by seq. */
export type FrameRef = { seq: string; type: string; chainRef: string | null };

/** A decision a rule or a person made about a call, and the frame that records it. */
export type FeedGate = { decision: string; frame: FrameRef };

export type FeedCall = {
  name: string;
  group: ToolGroup;
  /** What the call acted on, on one line and cut at `LINE_CAP`; null when the record says nothing more than the name. */
  arg: string | null;
  /** First frame of the call to its last; null for a call recorded in one frame or with no result yet. */
  durationMs: number | null;
  output: string | null;
  diffs: ToolDiff[];
  /** The call as it was made, for the row's fold. */
  raw: string | null;
  gates: FeedGate[];
  /**
   * The frame that records the call waiting on approval, when it is: the
   * receipt of a call that parked, or the request for approval.
   */
  parked: FrameRef | null;
  /** The public id (`apr_…`) of the approval a parked call waits on; null otherwise. */
  approvalId: string | null;
  /** No frame recorded a result, and nothing refused or parked the call. */
  pending: boolean;
  /** A body of the call was cut at the contract's ceiling. */
  truncated: boolean;
  /** The call's own frame: its receipt, or its request when none was written. */
  frame: FrameRef;
};

type FeedRecall = TranscriptRecall;

type FeedBase = {
  /** The row's key: unique in the feed, and stable across reads. */
  key: string;
  /** The key of the entry the row draws. */
  entry: string;
  /** The instant of the entry the row reads, and how far into the run it sits. */
  at: string;
  elapsedMs: number;
  /** The chip that shows or hides the row; null for a row no chip governs. */
  group: FeedGroup | null;
  /** The server counts the row's entry under errors (`error`): it failed or was refused. */
  failed: boolean;
  subagent: TranscriptEntry["subagent"];
  /**
   * The key of the entry that spawned this subagent row's chain, so the view
   * draws the subagent's work inside the call that spawned it; null for a row
   * of the run's own.
   */
  parent: string | null;
  /** What the run had spent by this row: the contract's own running total. */
  spent: Cost | null;
  /** The read's search found its query in the entry, so the row opens. */
  matched: boolean;
};

export type FeedRow = FeedBase &
  (
    | { kind: "prompt"; text: string; turn: number | null; first: boolean }
    | { kind: "text"; text: string }
    | {
        /**
         * A model step whose kept reply said nothing in words: the one row
         * it draws under `responses`, so the chip's count, which the server
         * takes without reading the reply, is what the chip shows.
         */
        kind: "calls";
        /**
         * The tools the reply called that a tool step recorded, in order;
         * each is drawn as that step's row. A call no tool step recorded is
         * drawn as its own row after this one, so it is not named here.
         */
        tools: string[];
      }
    | {
        kind: "thinking";
        /**
         * The thought as the reply kept it; null when the harness recorded
         * that the model thought (`tokens`) and kept none of the words.
         */
        text: string | null;
        /** The reasoning tokens behind a thought no words were kept for; null otherwise. */
        tokens: number | null;
      }
    | { kind: "tool"; call: FeedCall }
    | {
        kind: "usage";
        model: string | null;
        usage: TranscriptUsage | null;
        cost: Cost | null;
        /** The reasoning effort the call ran at, as the harness recorded it; null when unrecorded. */
        effort: string | null;
        frame: FrameRef;
      }
    | { kind: "recall"; recall: FeedRecall; frame: FrameRef }
    | { kind: "seal"; label: string | null; frame: FrameRef }
    | {
        kind: "event";
        name: string;
        text: string | null;
        gates: FeedGate[];
        frame: FrameRef;
      }
  );

type Block = NonNullable<TranscriptBody["blocks"]>[number];
type ToolUse = Extract<Block, { kind: "tool_use" }>;

/** The entry's opening frame. */
function openingOf(entry: TranscriptEntry): FrameRef {
  return {
    seq: entry.seq,
    type: entry.type,
    chainRef: entry.subagent?.chainRef ?? null,
  };
}

/** The frame one half was recorded on. */
function halfRef(half: TranscriptBody): FrameRef {
  return { seq: half.seq, type: half.type, chainRef: half.chainRef ?? null };
}

function gateOf(gate: TranscriptEntry["gates"][number]): FeedGate {
  return {
    decision: gate.decision,
    frame: { seq: gate.seq, type: gate.type, chainRef: gate.chainRef ?? null },
  };
}

/**
 * The chip a row of `entry` is drawn under. A row appears under a chip only
 * when the server counted its entry there (`kinds`), so a chip's count is
 * the entries it shows (ADR-182). A row the page would file under a chip the
 * entry does not answer goes under `responses` when the entry answers that,
 * and under no chip otherwise. Two rows take the fallback: a thinking block
 * of a model step that reported no reasoning tokens, since the server counts
 * `thinking` from the provider's report and reads no body; and a call the
 * reply made that no tool step recorded, since `tools` counts tool steps.
 */
function chipOf(
  entry: TranscriptEntry,
  wanted: FeedGroup | null,
): FeedGroup | null {
  if (wanted === null || entry.kinds.includes(wanted)) return wanted;
  return entry.kinds.includes("responses") ? "responses" : null;
}

function base(
  key: string,
  entry: TranscriptEntry,
  group: FeedGroup | null,
): FeedBase {
  return {
    key,
    entry: entry.key,
    at: entry.at,
    elapsedMs: entry.elapsedMs,
    group: chipOf(entry, group),
    // The server says which entries `counts.errors` counts (`error`), so the
    // errors toggle shows the entries its count counted. Every row of an
    // entry takes it, including a call the entry's reply made that no tool
    // step recorded, whose own result the server does not read.
    failed: entry.error,
    subagent: entry.subagent,
    parent: entry.parentKey,
    spent: entry.cumulativeCost,
    matched: entry.matches.length > 0,
  };
}

/** The headline and its qualifier on one line, or null when neither was recorded. */
function argOf(detail: ToolDetail | null): string | null {
  const parts = [detail?.headline ?? null, detail?.detail ?? null].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * The longest text a closed row carries, in characters. At the row's 12.5px
 * mono that is about 2,400px, wider than the argument's slot on a 2,560px
 * screen, so the cap never cuts text a reader could see. It keeps a heredoc
 * or an inline file out of every closed row. The open row shows it whole.
 *
 * @internal Exported for its test.
 */
export const LINE_CAP = 320;

/**
 * Text as a closed row prints it: each run of whitespace, newlines included,
 * becomes one space, and the text is cut at `LINE_CAP` with an ellipsis.
 */
export function closedLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > LINE_CAP ? `${line.slice(0, LINE_CAP - 1)}…` : line;
}

/** The call as it was made, as compact JSON; null when it holds nothing. */
function compactRaw(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return raw;
    return Object.keys(parsed).length === 0 ? null : JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

/**
 * What a closed row prints after the tool's name: the reading's headline, or
 * the call as it was made when the reading found none, as `closedLine` cuts
 * it. A call whose arguments are all objects has no headline, and its row
 * would otherwise print the name alone.
 */
function callArg(arg: string | null, raw: string | null): string | null {
  const line = closedLine(arg ?? compactRaw(raw) ?? "");
  return line === "" ? null : line;
}

/**
 * A tool reading with the target the gate recorded standing in for an input
 * nobody kept: that is the command or path the reader came for.
 */
function withTarget(
  detail: ToolDetail | null,
  target: string | null,
): ToolDetail | null {
  if (detail === null || detail.raw !== null || target === null) return detail;
  const cut = target.indexOf("\n");
  return {
    ...detail,
    headline: detail.headline ?? (cut === -1 ? target : target.slice(0, cut)),
    multiline: detail.headline === null ? cut !== -1 : detail.multiline,
    raw: target,
  };
}

function toolRow(entry: TranscriptEntry): FeedRow {
  const target =
    entry.target == null || entry.target === "" ? null : entry.target;
  const detail = withTarget(
    callDetail({
      // The server names the tool as its harness knows it (ADR-182); an
      // answer that did not leaves the name as recorded.
      name: entry.tool ?? entry.subject,
      family: entry.family ?? "tool",
      request: entry.request?.text ?? null,
      response: entry.response?.text ?? null,
    }),
    target,
  );
  const gates = entry.gates.map(gateOf);
  // The call's own frame: its receipt, or its request while it has none.
  const frame =
    entry.response !== null
      ? halfRef(entry.response)
      : entry.request !== null
        ? halfRef(entry.request)
        : openingOf(entry);
  const lastGate = gates[gates.length - 1];
  const call: FeedCall = {
    name: detail?.name ?? entry.tool ?? entry.subject ?? entry.type,
    group: detail?.group ?? entry.family ?? "tool",
    arg: callArg(detail === null ? target : argOf(detail), detail?.raw ?? null),
    durationMs: entry.durationMs,
    output: detail?.output ?? null,
    diffs: detail?.diffs ?? [],
    raw: detail?.raw ?? null,
    gates,
    // A call that parked on its receipt waits on the approval the receipt
    // names; one waiting on a request for approval waits on that request.
    parked:
      entry.outcome !== "parked"
        ? null
        : entry.response !== null
          ? halfRef(entry.response)
          : (lastGate?.frame ?? frame),
    approvalId: entry.approvalId,
    pending: entry.outcome === "pending",
    truncated:
      entry.request?.truncated === true || entry.response?.truncated === true,
    frame,
  };
  return { ...base(entry.key, entry, "tools"), kind: "tool", call };
}

/**
 * A tool the model called that no tool step recorded: the gateway saw the
 * call in the reply, and the harness wrote no frame of its own for it. Its
 * result is what the reply's own result block said, when one was kept. No
 * count takes it as a tool call, so it is drawn as part of the reply
 * (`chipOf`).
 */
function blockToolRow(
  block: ToolUse,
  key: string,
  entry: TranscriptEntry,
  frame: FrameRef,
): FeedRow {
  const detail = toolDetailOf(
    block.tool ?? block.name,
    block.family ?? "tool",
    block.input,
    block.result?.summary ?? null,
  );
  const call: FeedCall = {
    name: detail?.name ?? block.tool ?? block.name,
    group: detail?.group ?? block.family ?? "tool",
    arg: callArg(argOf(detail), detail?.raw ?? null),
    durationMs: null,
    output: detail?.output ?? null,
    diffs: detail?.diffs ?? [],
    raw: detail?.raw ?? null,
    gates: [],
    parked: null,
    approvalId: null,
    pending: block.result === null,
    truncated: entry.response?.truncated === true,
    frame,
  };
  // Filed under `tools` only if the server counted this entry there, which
  // it does not for a model step (`chipOf`). A failed result is shown in the
  // row's output and is not an error of the entry's: no count reads it.
  return { ...base(key, entry, "tools"), kind: "tool", call };
}

/**
 * The rows a model step reads as: what it thought, what it said, what it
 * cost, then any tool it called that no tool step recorded. A call a tool
 * step recorded (`stepKey`) is that step's row, so it is not drawn here, and
 * no row is ever a model frame with JSON to open.
 *
 * A step the server counts under `responses` draws a row under it whatever
 * its reply said (ADR-182). The server counts every step whose reply was
 * kept, since which of these rows a reply draws needs the reply read and a
 * count reads none. So a reply that said nothing in words, one that only
 * called tools, draws a `calls` row naming them.
 *
 * Each row's chip is the server's (`chipOf`): a kept thought is drawn under
 * `thinking` when the step reported reasoning tokens and under `responses`
 * when it did not, and a call no tool step recorded is drawn under
 * `responses`. A step that failed and has nothing else to draw draws one
 * failed row, so the errors count is what the errors toggle shows.
 */
function modelRows(entry: TranscriptEntry): FeedRow[] {
  const reply = entry.response;
  const frame =
    reply !== null
      ? halfRef(reply)
      : entry.request !== null
        ? halfRef(entry.request)
        : openingOf(entry);
  const blocks = reply?.blocks;
  const rows: FeedRow[] = [];
  const said = (key: string, kind: "text" | "thinking", text: string) => {
    const at = base(key, entry, kind === "text" ? "responses" : "thinking");
    rows.push(
      kind === "text"
        ? { ...at, kind, text }
        : { ...at, kind, text, tokens: null },
    );
  };
  if (blocks === undefined) {
    // A reply kept as plain words is drawn as them. One kept as JSON the
    // recorder did not assemble is drawn by its cost alone, never as JSON to
    // open.
    const text = reply?.text ?? null;
    if (text !== null && text.trim() !== "" && parseBody(text) === null)
      said(`${entry.key}:text`, "text", text);
  } else {
    blocks.forEach((block, index) => {
      if (block.kind !== "text" && block.kind !== "thinking") return;
      if (block.text.trim() === "") return;
      said(`${entry.key}:${String(index)}`, block.kind, block.text);
    });
  }
  // A harness that reports reasoning tokens and keeps none of the thought
  // (Claude Code over OTel) still says the model thought, and how much.
  const thought = rows.some((row) => row.kind === "thinking");
  const reasoning = entry.usage?.reasoning ?? null;
  if (!thought && reasoning !== null && reasoning > 0) {
    rows.push({
      ...base(`${entry.key}:thinking`, entry, "thinking"),
      kind: "thinking",
      text: null,
      tokens: reasoning,
    });
  }
  if (
    entry.kinds.includes("responses") &&
    !rows.some((row) => row.kind === "text")
  ) {
    rows.push({
      ...base(`${entry.key}:calls`, entry, "responses"),
      kind: "calls",
      tools: (blocks ?? []).flatMap((block) =>
        block.kind === "tool_use" && block.stepKey !== null
          ? [block.tool ?? block.name]
          : [],
      ),
    });
  }
  const usage = entry.usage ?? null;
  const effort =
    entry.effort == null || entry.effort === "" ? null : entry.effort;
  if (entry.cost !== null || usage !== null || effort !== null) {
    rows.push({
      ...base(`${entry.key}:usage`, entry, "usage"),
      kind: "usage",
      // `provider/model`, drawn by the model's own name.
      model: entry.model?.split("/").pop() ?? null,
      usage,
      cost: entry.cost,
      effort,
      frame,
    });
  }
  blocks?.forEach((block, index) => {
    if (block.kind !== "tool_use" || block.stepKey !== null) return;
    rows.push(
      blockToolRow(block, `${entry.key}:u${String(index)}`, entry, frame),
    );
  });
  // A call that failed with no reply kept and no figures still shows: the
  // server counts it under errors, so it draws one failed row naming the
  // model, under no chip.
  if (rows.length === 0 && entry.error) {
    rows.push({
      ...base(`${entry.key}:failed`, entry, null),
      kind: "event",
      name: entry.model?.split("/").pop() ?? entry.type,
      text: null,
      gates: [],
      frame,
    });
  }
  return rows;
}

function eventRow(entry: TranscriptEntry): FeedRow {
  return {
    ...base(entry.key, entry, null),
    kind: "event",
    name: entry.subject ?? entry.type,
    text: soleBody(entry)?.text ?? null,
    gates: entry.gates.map(gateOf),
    frame: openingOf(entry),
  };
}

/**
 * The rows one entry draws, in the order they read. An entry the server says
 * has nothing to show (`quiet`) draws none, and every other entry draws at
 * least one. Quiet takes in a prompt or reply with no words, and a reply that
 * repeats words the reader was just shown (`echoOf`): the server reads and
 * compares the words, and its counts leave out every quiet entry, so a count
 * and the rows drawn agree (ADR-182). This module reads no words to decide
 * it. A turn (`node` null) is a group, not a row.
 *
 * @internal Exported for its unit test; the view draws rows through `feedOf`.
 */
export function rowsOf(entry: TranscriptEntry): FeedRow[] {
  if (entry.quiet) return [];
  switch (entry.node) {
    case "prompt":
      return [
        {
          ...base(entry.key, entry, "prompt"),
          kind: "prompt",
          text: entry.request?.text ?? "",
          turn: entry.turn,
          first: false,
        },
      ];
    case "reply":
      return [
        {
          ...base(entry.key, entry, "responses"),
          kind: "text",
          text: entry.response?.text ?? "",
        },
      ];
    case "model":
      return modelRows(entry);
    case "tool":
      return [toolRow(entry)];
    case "recall":
      return [
        {
          ...base(entry.key, entry, "recall"),
          kind: "recall",
          // The server reads a recall on every recall entry; one it did not
          // state is drawn as a recall that listed nothing.
          recall: entry.recall ?? {
            unit: "frames",
            count: null,
            tokens: null,
            cut: null,
            items: [],
            bundleVersion: null,
            body: "unlisted",
          },
          frame: openingOf(entry),
        },
      ];
    case "seal":
      return [
        {
          ...base(entry.key, entry, "seal"),
          kind: "seal",
          label: entry.label === entry.type ? null : entry.label,
          frame: openingOf(entry),
        },
      ];
    case "policy":
    case "control":
    case "event":
      return [eventRow(entry)];
    case null:
      return [];
  }
}

/**
 * The run's rows, in the order the server placed its entries, with the first
 * prompt row flagged: the prompt the run was started with, which the row
 * credits with the task it was given.
 */
export function feedOf(entries: readonly TranscriptEntry[]): FeedRow[] {
  const rows = entries.flatMap(rowsOf);
  const first = rows.findIndex((row) => row.kind === "prompt");
  return first === -1
    ? rows
    : rows.map((row, index) =>
        index === first && row.kind === "prompt"
          ? { ...row, first: true }
          : row,
      );
}
