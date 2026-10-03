"use client";
// The Transcript tab's feed and its transport (mockup `transcriptTab`, `txRow`
// and the `.tx-*` rules in engine.css; pages/run.md, Transcript).
//
// The feed draws as the run's harness drew it, after the v3 mockup's
// `replay.js`: one row model under a skin per harness (`transcript-skin.tsx`
// and `src/ui/transcript-skins.css`). Each row is a clock in the gutter, the
// harness's line, and Oxagen's chips in the margin beside it. The replay bar
// above the terminal holds the transport and a scrubber over the rows read.
//
// The feed is the run as its operator saw it: the prompt, the model's words
// and thinking, each tool call with the output it read, what each model step
// cost, what was recalled, and the stop. Every row is one line until it is
// opened. A tool row's line is the tool's name and its arguments, cut at
// `LINE_CAP`; opening it shows the full arguments, every diff line, and the
// output. Oxagen's own frames sit behind the chips: a ⚖ chip opens the
// decision's frame on the Governed actions tab, and a frame chip opens a
// reply's or a call's.
//
// The page reads the run at `steps`, which the server folds (ADR-182), and
// this view draws each entry's rows (`rowsOf`). A subagent's rows sit under
// the call that spawned it, by the entry's `parentKey`. Each chip's count and
// the errors count are the server's (`counts`), counted over the whole run.
// The chips and the errors toggle show and hide rows already read. The
// search is the server's: the query goes out once the reader stops typing,
// the entries that hold it come back, and a row whose entry matched opens.
//
// The transport moves the viewer, never the run. Its position is a count of
// rows shown; playback reveals the next row after the recorded gap to it,
// compressed and divided by the speed (`txPaced`), and a search shows every
// match at once. A sealed run plays from its first row as the page opens; a
// live run opens following its head, and pausing stops following without
// touching the run.
//
// A run can record for days and hold hundreds of thousands of frames, so the
// view reads a page at a time (`TRANSCRIPT_PAGE`, #4427). A sealed run opens
// on its first page and reads the next once playback passes half of what it
// holds. A live run opens on its last page and reads the page ahead of it
// when the reader scrolls up.
//
// A live run follows its own head over the SSE route
// (`GET /v1/:org/:ws/runs/:run_id/stream`, reached same-origin through the
// `/api/v1/*` rewrite). The stream carries frames, and the transcript carries
// entries the contract derives from them, so a frame landing is the signal to
// read the tail rather than something to render. A cursor this capability
// did not write is refused and said so.
import { useLocale, useTranslations } from "next-intl";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Cost, ratioOfMicros } from "@/data/contracts/money";
import {
  type RunTranscript,
  TRANSCRIPT_ENTRY_MAX,
  TRANSCRIPT_QUERY_MAX,
  type TranscriptCounts,
  type TranscriptSearch,
} from "@/data/contracts/run";
import { isStale, type RunRow } from "@/data/contracts/runs";
import type { DiffLine } from "@/shared/line-diff";
import { routes } from "@/shared/safe-path";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { formatCount, formatDuration, ratioWidth } from "@/ui/money-format";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { ProviderMark } from "@/ui/provider-mark";
import type { ActionResult } from "@/server/kernel";
import { readTranscriptPage } from "./actions";
import { frameHref } from "./frame-link";
import type { KindFilter } from "./tab-props";
import { Note } from "./parts";
import type { ToolDiff } from "./tool-detail";
import {
  closedLine,
  FEED_GROUPS,
  type FeedCall,
  type FeedGate,
  type FeedGroup,
  feedOf,
  type FeedRow,
  type Frames,
  type FrameRef,
  entryKey,
  mergeEntries,
  mergeTail,
  prependEntries,
  rebaseEntries,
  TRANSCRIPT_PAGE,
} from "./transcript-rows";
import { SkinBanner, SkinFoot, skinOf } from "./transcript-skin";
import { useRunStream } from "./use-run-stream";
import { useStaleRefresh } from "./use-stale-refresh";

type Place = { org: string; ws: string; runId: string };

/** The run facts the feed's header line and its rows read. */
export type TranscriptRun = Pick<
  RunRow,
  | "status"
  | "taskRef"
  | "agentKey"
  | "model"
  | "turns"
  | "steps"
  | "operatorName"
  | "sealedAt"
  | "ingressPaused"
  | "commandBlock"
  | "harness"
>;

/** Why a later page did not arrive, in the shape the action answers with. */
type PageFailure = Exclude<ActionResult<unknown>, { ok: true }>;

/** What the server's search answered for one query. */
type Found = {
  /** The query as it was sent. */
  query: string;
  entries: RunTranscript["entries"];
  /** Where the next page of matches starts; null when none lies past these. */
  cursor: string | null;
  search: TranscriptSearch | null;
};

/** How long the reader stops typing before the search goes to the server. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * How close to the feed's foot the reader must be for new rows to keep it
 * there (mockup `replay.js`, 60px).
 */
const FOLLOW_PX = 60;

/** How close to the feed's top a live view reads the page ahead. */
const OLDER_PX = 120;

/** Where the page's read opened: the run's first entry, or its last page. */
export type TranscriptFrom = "start" | "end";

/**
 * The field's words as a query the contract takes: trimmed, and cut at its
 * longest. Nothing but space is no query.
 */
function searchText(raw: string): string {
  return raw.trim().slice(0, TRANSCRIPT_QUERY_MAX).trim();
}

/** `TX_SPEEDS=[1,2,3,6]`. */
const SPEEDS = [1, 2, 3, 6] as const;
type Speed = (typeof SPEEDS)[number];

/**
 * `txPaced`: the recorded gap to the next row, divided by the speed, held
 * between 90 ms and 1.4 s (both divided by the speed too, so 6× reads as six
 * times faster through a run whose gaps are either near zero or long).
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function paceMs(gapMs: number, speed: number): number {
  return Math.max(
    90 / speed,
    Math.min(1400 / speed, Math.max(0, gapMs) / speed),
  );
}

/**
 * A click on a closed row's line opens it, the way its fold button does. A
 * click that ends a text selection is the reader copying, not asking to open.
 */
function lineClick(open: () => void): () => void {
  return () => {
    if ((window.getSelection()?.toString() ?? "") !== "") return;
    open();
  };
}

// ── The design's rules, as class recipes (ADR-226) ──────────────────────────

/**
 * `.txs { font-family:var(--mono); font-size:12.5px; line-height:1.65;
 * color:var(--fg) }`.
 */
const txs =
  "flex min-w-0 flex-col font-mono text-sm leading-[1.65] text-foreground";
/** `.tx-tools { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:0 0 10px }` */
const txTools = "flex flex-wrap items-center gap-2 pb-2.5";
/**
 * `.tx-tools input { background:var(--void); border:1px solid var(--border);
 * border-radius:8px; padding:6px 10px; font-size:12px; width:220px }`; a
 * phone gets the 16px input the house sheets use.
 */
const txSearch =
  "w-55 max-w-full max-md:w-full rounded-lg border border-border bg-void px-2.5 py-1.5 font-mono text-sm text-foreground placeholder:text-dim focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring max-md:text-input-touch";
/** `.tx-kinds { display:flex; flex-wrap:wrap; gap:3px }` */
const txKinds = "flex flex-wrap gap-0.75";
/**
 * `.tx-kind { display:inline-flex; gap:6px; padding:3px 8px 3px 6px;
 * border-radius:6px; font-size:11px; color:var(--muted) }`, pressed
 * `{ background:var(--hl); color:var(--fg); box-shadow:inset 0 0 0 1px
 * var(--rule) }`, released `{ color:var(--dim) }` with its words struck.
 * `.all { padding-left:8px }`, and `.err[aria-pressed="true"] {
 * color:var(--st-failed) }`.
 */
const kindShape =
  "inline-flex items-center gap-1.5 rounded-md py-0.75 pr-2 font-mono text-xs focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-9";
const kindPressed =
  "aria-pressed:bg-hl aria-pressed:shadow-[inset_0_0_0_1px_var(--rule)] aria-[pressed=false]:text-dim aria-[pressed=false]:[&>span:not([data-dot])]:line-through";
const txKind = `${kindShape} ${kindPressed} pl-1.5 text-muted-foreground aria-pressed:text-foreground`;
const txKindAll = `${kindShape} pl-2 text-muted-foreground hover:text-foreground`;
const txKindErrors = `${kindShape} ${kindPressed} pl-1.5 text-muted-foreground aria-pressed:text-error`;
/** `.tx-kind .n { font-size:10px; color:var(--dim) }` */
const txKindCount = "text-xs tabular-nums text-dim";
/**
 * `.tx-kind .d { width:8px; height:8px; border-radius:2px; background:var(--c);
 * box-shadow:0 0 0 1px <c 40%> }`, and released `{ background:transparent;
 * box-shadow:inset 0 0 0 1.5px var(--c); opacity:.7 }`. One pair per frame
 * kind hue (`TX_HUE`), written out so Tailwind sees every class.
 */
const DOT: Record<FeedGroup, { on: string; off: string }> = {
  prompt: {
    on: "bg-fk-op shadow-[0_0_0_1px_color-mix(in_srgb,var(--fk-op)_40%,transparent)]",
    off: "shadow-[inset_0_0_0_1.5px_var(--fk-op)] opacity-70",
  },
  responses: {
    on: "bg-fk-model shadow-[0_0_0_1px_color-mix(in_srgb,var(--fk-model)_40%,transparent)]",
    off: "shadow-[inset_0_0_0_1.5px_var(--fk-model)] opacity-70",
  },
  thinking: {
    on: "bg-fk-model shadow-[0_0_0_1px_color-mix(in_srgb,var(--fk-model)_40%,transparent)]",
    off: "shadow-[inset_0_0_0_1.5px_var(--fk-model)] opacity-70",
  },
  tools: {
    on: "bg-fk-tool shadow-[0_0_0_1px_color-mix(in_srgb,var(--fk-tool)_40%,transparent)]",
    off: "shadow-[inset_0_0_0_1.5px_var(--fk-tool)] opacity-70",
  },
  usage: {
    on: "bg-fk-gov shadow-[0_0_0_1px_color-mix(in_srgb,var(--fk-gov)_40%,transparent)]",
    off: "shadow-[inset_0_0_0_1.5px_var(--fk-gov)] opacity-70",
  },
  recall: {
    on: "bg-fk-ctx shadow-[0_0_0_1px_color-mix(in_srgb,var(--fk-ctx)_40%,transparent)]",
    off: "shadow-[inset_0_0_0_1.5px_var(--fk-ctx)] opacity-70",
  },
  seal: {
    on: "bg-fk-gov shadow-[0_0_0_1px_color-mix(in_srgb,var(--fk-gov)_40%,transparent)]",
    off: "shadow-[inset_0_0_0_1.5px_var(--fk-gov)] opacity-70",
  },
};
/**
 * `.btn.sm` inside `.tx-play { padding:3px 8px; font-size:11.5px;
 * min-width:30px; justify-content:center }` over `.btn { border:1px solid
 * var(--border); background:var(--panel); border-radius:7px; font-weight:500;
 * gap:7px }`, `.btn:hover { border-color:var(--rule); background:var(--hl) }`
 * and `.tx-play .btn.sm[aria-pressed="true"]` the same; `.ghost` drops the
 * fill, and the play button is `min-width:74px`.
 */
const buttonShape =
  "inline-flex items-center justify-center gap-1.75 rounded-[7px] border border-border px-2 py-0.75 font-mono text-xs font-medium text-foreground transition-colors hover:border-rule hover:bg-hl aria-pressed:border-rule aria-pressed:bg-hl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 max-md:min-h-9";
const txButton = `${buttonShape} min-w-7.5 bg-card`;
const txGhost = `${buttonShape} min-w-7.5 bg-transparent`;
const txPlayButton = `${buttonShape} min-w-18.5 bg-card`;
/**
 * `.seg { display:inline-flex; gap:2px; padding:2px; border:1px solid
 * var(--border); border-radius:8px; background:var(--void) }` and `.seg .btn
 * { border-color:transparent; background:transparent }`, pressed `{
 * background:var(--hl); border-color:var(--rule) }`.
 */
const txSeg =
  "ml-1 inline-flex gap-0.5 rounded-lg border border-border bg-void p-0.5";
const txSegButton =
  "inline-flex min-w-7.5 items-center justify-center rounded-[7px] border border-transparent bg-transparent px-2 py-0.75 font-mono text-xs font-medium text-foreground hover:bg-hl aria-pressed:border-rule aria-pressed:bg-hl max-md:min-h-9";
/** `.tx-play .cnt { font-size:10.5px; color:var(--dim); margin-left:4px }` */
const txCount = "ml-1 whitespace-nowrap text-xs tabular-nums text-dim";
/**
 * `.tx-burn { display:flex; gap:8px; font-size:10.5px; color:var(--muted) }`,
 * `.bar { width:120px; height:4px; border-radius:2px; background:var(--hl) }`,
 * `.bar i { background:var(--st-approval) }`.
 */
const txBurn =
  "flex items-center gap-2 whitespace-nowrap text-xs tabular-nums text-muted-foreground max-md:flex-wrap max-md:whitespace-normal";
/**
 * A prose line: every line as it was written once the row opens, and one
 * line cut with an ellipsis while it is closed. The ink is the skin's.
 */
const txProse = "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]";
const txProseLine = "min-w-0 truncate";
/**
 * `.tx-chip { font-size:10.5px; color:var(--muted); background:var(--panel);
 * border:1px solid var(--border); border-radius:5px; padding:0 6px;
 * line-height:1.6 }`, and its tones: `.ok` (allowed), `.warn` (the approval
 * hue), `.err` (failed), `.cost { color:var(--fg); border-color:var(--rule) }`,
 * `.burn { color:var(--dim) }`, and `.gov { color:var(--st-approval);
 * border-color:<st-approval 40%> }` with `:hover { color:var(--fg) }` for a
 * chip that opens one of Oxagen's frames. Each tone is a whole class list, so
 * no chip carries two inks.
 */
const chipShape =
  "whitespace-nowrap rounded-[5px] border bg-card px-1.5 font-mono text-xs leading-[1.6] tabular-nums";
const CHIP = {
  plain: `${chipShape} border-border text-muted-foreground`,
  ok: `${chipShape} border-border text-success`,
  warn: `${chipShape} border-border text-info`,
  err: `${chipShape} border-border text-error`,
  cost: `${chipShape} border-rule text-foreground`,
  burn: `${chipShape} border-border text-dim`,
  gov: `${chipShape} border-info/40 text-info hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring`,
  link: `${chipShape} border-border text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring`,
} as const;
/** `.tx-empty { padding:18px 16px; color:var(--dim) }`, inside the line column. */
const txEmpty = "py-3 text-dim";
/** The control over a live view's first row that reads the page ahead. */
const txOlder = "flex justify-center pt-1 pb-2";
/** `.txs mark { background:var(--gold); color:var(--on-gold); border-radius:2px }` */
const txMark = "rounded-[2px] bg-gold px-px text-on-gold";

/**
 * How many tool calls the scrubber marks one by one. Past it the marks would
 * run together, so only prompts and errors are marked.
 */
const TOOL_MARKS_MAX = 300;
/** The scrubber's width in marks: two marks that round to one place draw once. */
const MARK_SLOTS = 200;

/**
 * The recorded pause before a row that the margin names, so a run that sat
 * for an hour does not read as one that ran straight through.
 */
const GAP_NOTE_MS = 60_000;

/** A style that also sets CSS custom properties, such as a row's `--depth`. */
type StyleWithVariables = CSSProperties & Record<`--${string}`, string>;

// ── Pieces ──────────────────────────────────────────────────────────────────

/** `txHi`: the text with every match of the search marked. */
function Hi({ text, q }: { text: string; q: string }) {
  if (q === "") return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(q, from); at >= 0; at = lower.indexOf(q, from)) {
    parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className={txMark}>
        {text.slice(at, at + q.length)}
      </mark>,
    );
    from = at + q.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

/**
 * The row's clock, in the gutter: the instant in the viewer's zone, with its
 * place in the run as the title.
 */
function Clock({ at, elapsedMs }: { at: string; elapsedMs: number }) {
  const format = useFormatter();
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  return (
    <time
      dateTime={at}
      title={t("elapsed", { time: formatDuration(elapsedMs, locale) })}
    >
      {format.dateTime(new Date(at), {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 1,
        hourCycle: "h23",
      })}
    </time>
  );
}

/**
 * A chip that opens one frame on the Governed actions tab. A subagent's frame
 * is on its own chain, numbered from 0 like the run's, so the link names the
 * chain beside the seq and opens that frame, not the run's frame of that
 * number (#3823).
 */
function FrameChip({
  frame,
  children,
  place,
  className = CHIP.gov,
}: {
  frame: FrameRef;
  children: ReactNode;
  place: Place;
  className?: string;
}) {
  return (
    <SafeLink to={frameHref(place, frame)} className={className}>
      {children}
    </SafeLink>
  );
}

/** `txGovChip`: ⚖, the decision, and the frame that records it. */
function GateChip({ gate, place }: { gate: FeedGate; place: Place }) {
  const t = useTranslations("run.transcript");
  return (
    <FrameChip frame={gate.frame} place={place}>
      <span aria-hidden="true">⚖ </span>
      {t("gate", { decision: gate.decision, seq: gate.frame.seq })}
    </FrameChip>
  );
}

function SubagentChip({ row }: { row: FeedRow }) {
  const t = useTranslations("run.transcript");
  if (row.subagent === undefined) return null;
  return (
    <span data-testid="transcript-subagent" className={CHIP.plain}>
      {row.subagent.type === null
        ? t("subagent")
        : t("subagentTyped", { type: row.subagent.type })}
    </span>
  );
}

/**
 * The control that opens and closes one row. A prose row leads with it
 * (`⏵`/`⏶`); a call row ends its margin with it (`⋯`/`⏶`).
 */
function Fold({
  open,
  label,
  closedGlyph,
  onToggle,
  className = "",
}: {
  open: boolean;
  label: string;
  closedGlyph: "⏵" | "⋯";
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`tx-fold ${className}`}
      aria-expanded={open}
      aria-label={label}
      onClick={onToggle}
    >
      {open ? "⏶" : closedGlyph}
    </button>
  );
}

/**
 * `txDiffBlock`: the path, the stat, and every changed line as the harness
 * prints it, one line number and a sign, scrolled past 320px.
 */
function DiffBlock({ change, q }: { change: ToolDiff; q: string }) {
  const t = useTranslations("run.transcript");
  type Line = DiffLine | { op: "gap"; key: string };
  const shown: Line[] = change.diff.hunks.flatMap((hunk, index) => [
    ...(index === 0
      ? []
      : [{ op: "gap" as const, key: `gap-${String(index)}` }]),
    ...hunk.lines,
  ]);
  return (
    <div data-testid="tx-diff" className="tx-diff">
      <div className="tx-dpath">
        <b>{change.path}</b>
        {change.created ? <span>{t("newFile")}</span> : null}
        <span>
          <span className="tx-ok">+{change.diff.added}</span>{" "}
          <span className="tx-err">−{change.diff.removed}</span>
        </span>
      </div>
      <div className="tx-dlines">
        {shown.map((line) =>
          line.op === "gap" ? (
            <div key={line.key} className="tx-dl gap">
              ⋯
            </div>
          ) : (
            <div
              key={`${line.op}-${String(line.before ?? "n")}-${String(line.after ?? "n")}`}
              className={`tx-dl ${line.op}`}
            >
              <span className="tx-dn">
                {(line.op === "del" ? line.before : line.after) ?? ""}
              </span>
              <span className="tx-ds">
                {line.op === "add" ? "+" : line.op === "del" ? "−" : " "}
              </span>
              <span className="min-w-0">
                <Hi text={line.text} q={q} />
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

// ── Rows ────────────────────────────────────────────────────────────────────

type RowProps = {
  row: FeedRow;
  q: string;
  open: boolean;
  onToggle: (key: string) => void;
  place: Place;
  /** The margin's note on the recorded pause before the row, or null. */
  pause: ReactNode;
};

/**
 * One row's two cells: the line as the harness prints it (`.tc`), and
 * Oxagen's margin beside it (`.tm`) for chips, cost, frames and the pause
 * before it. The wrapper draws no box (`display: contents`), so both cells
 * sit in the row's grid.
 */
function Cells({
  testId,
  line,
  margin,
  pause,
}: {
  testId?: string;
  line: ReactNode;
  margin?: ReactNode;
  pause: ReactNode;
}) {
  return (
    <div data-testid={testId} className="tx-cells">
      <div className="tc">{line}</div>
      <div className="tm">
        {margin}
        {pause}
      </div>
    </div>
  );
}

/**
 * A prose row's words: one line cut at the column's edge while the row is
 * closed, every line as it was written once it opens. Every prose row can
 * open, because whether its line overflowed is the browser's to know.
 */
function Prose({
  text,
  q,
  open,
  onToggle,
}: {
  text: string;
  q: string;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("run.transcript");
  return (
    <div className={open ? txProse : txProseLine}>
      <Fold
        open={open}
        label={open ? t("showLess") : t("showFull")}
        closedGlyph="⏵"
        onToggle={onToggle}
        className="pr-ch"
      />
      {open ? (
        <Hi text={text} q={q} />
      ) : (
        <span className="cursor-pointer" onClick={lineClick(onToggle)}>
          <Hi text={closedLine(text)} q={q} />
        </span>
      )}
    </div>
  );
}

/**
 * The operator's prompt. The role is the skin's glyph, so its word is for a
 * screen reader only.
 */
function PromptRow({
  row,
  q,
  open,
  onToggle,
  run,
  pause,
}: Omit<RowProps, "row" | "place"> & {
  row: Extract<FeedRow, { kind: "prompt" }>;
  run: TranscriptRun;
}) {
  const t = useTranslations("run.transcript");
  return (
    <Cells
      testId="transcript-you"
      pause={pause}
      line={
        <div className="tx-ln tx-user">
          <span className="sr-only">{t("you")}</span>
          <Prose
            text={row.text}
            q={q}
            open={open}
            onToggle={() => {
              onToggle(row.key);
            }}
          />
        </div>
      }
      margin={
        open ? (
          <>
            {run.operatorName === null ? null : (
              <span className="mg-note">
                {t("operator", { name: run.operatorName })}
              </span>
            )}
            {row.first && run.taskRef !== null ? (
              <span className="mg-note">{t("task", { ref: run.taskRef })}</span>
            ) : null}
            <span className="mg-note">
              {row.first
                ? t("firstPrompt")
                : row.turn === null
                  ? t("laterPrompt")
                  : t("turn", { n: row.turn })}
            </span>
          </>
        ) : null
      }
    />
  );
}

function TextRow({
  row,
  q,
  open,
  onToggle,
  answer,
  pause,
}: Omit<RowProps, "row" | "place"> & {
  row: Extract<FeedRow, { kind: "text" }>;
  answer: boolean;
}) {
  const t = useTranslations("run.transcript");
  return (
    <Cells
      testId="transcript-agent"
      pause={pause}
      line={
        <div className="tx-ln tx-say">
          <span className="sr-only">{answer ? t("answer") : t("agent")}</span>
          <Prose
            text={row.text}
            q={q}
            open={open}
            onToggle={() => {
              onToggle(row.key);
            }}
          />
        </div>
      }
      margin={<SubagentChip row={row} />}
    />
  );
}

/**
 * A model step whose kept reply said nothing in words: what it called, on
 * one quiet line. It is the step's row under the responses chip, so that
 * chip shows every step it counts.
 */
function CallsRow({
  row,
  pause,
}: {
  row: Extract<FeedRow, { kind: "calls" }>;
  pause: ReactNode;
}) {
  const t = useTranslations("run.transcript");
  const line =
    row.tools.length === 0
      ? t("saidNothing")
      : t("calledTools", { tools: row.tools.join(", ") });
  return (
    <Cells
      testId="transcript-calls"
      pause={pause}
      line={
        <div className="tx-ln tx-say tx-quiet truncate" data-truncate={line}>
          <span className="sr-only">{t("agent")}</span>
          {line}
        </div>
      }
      margin={<SubagentChip row={row} />}
    />
  );
}

function ThinkingRow({
  row,
  q,
  open,
  onToggle,
  pause,
}: Omit<RowProps, "row" | "place"> & {
  row: Extract<FeedRow, { kind: "thinking" }>;
}) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  if (row.text === null) {
    const unkept = t("thinkingUnkept", {
      count: formatCount(row.tokens ?? 0, locale),
    });
    return (
      <Cells
        testId="step-thinking-unkept"
        pause={pause}
        line={
          <div className="tx-ln tx-think truncate" data-truncate={unkept}>
            {unkept}
          </div>
        }
      />
    );
  }
  const lines = row.text.split("\n").length;
  const toggle = () => {
    onToggle(row.key);
  };
  return (
    <Cells
      pause={pause}
      line={
        <div className="tx-ln tx-think">
          <div className="flex min-w-0 items-baseline gap-ch">
            <button
              type="button"
              className="tx-fold flex-none"
              aria-expanded={open}
              onClick={toggle}
            >
              <span aria-hidden="true">{open ? "⏶ " : "⏵ "}</span>
              {t("thinkingLines", { count: lines })}
            </button>
            {open ? null : (
              <span
                data-testid="tx-think"
                className="min-w-0 cursor-pointer truncate"
                onClick={lineClick(toggle)}
              >
                <Hi text={closedLine(row.text)} q={q} />
              </span>
            )}
          </div>
          {open ? (
            <div data-testid="tx-think" className={txProse}>
              <Hi text={row.text} q={q} />
            </div>
          ) : null}
        </div>
      }
    />
  );
}

/**
 * What a call's glyph says: failed, waiting on an approval, still running,
 * or done. A call a sealed run never answered says none of them.
 */
function callState(
  row: FeedRow,
  call: FeedCall,
  live: boolean,
): "err" | "ask" | "run" | "ok" | undefined {
  if (row.failed) return "err";
  if (call.parked !== null) return "ask";
  if (call.pending) return live ? "run" : undefined;
  return "ok";
}

function ToolRow({
  row,
  call,
  q,
  open,
  onToggle,
  place,
  live,
  pause,
}: RowProps & { call: FeedCall; live: boolean }) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const failed = row.failed;
  const lines = call.output === null ? 0 : call.output.split("\n").length;
  // An edit's diff is the whole of what it did; its output only restates it,
  // unless the edit failed and the output says why.
  const output = call.diffs.length === 0 || failed ? call.output : null;
  const added = call.diffs.reduce((sum, each) => sum + each.diff.added, 0);
  const removed = call.diffs.reduce((sum, each) => sum + each.diff.removed, 0);
  const toggle = () => {
    onToggle(row.key);
  };
  return (
    <Cells
      pause={pause}
      line={
        <>
          <div
            className="tx-ln tx-call"
            data-state={callState(row, call, live)}
            data-tool={call.group}
          >
            {failed ? (
              <span aria-hidden="true" className="tx-x">
                ✗
              </span>
            ) : null}
            <span
              data-testid="tx-call-line"
              className="tx-head"
              onClick={lineClick(toggle)}
            >
              <span
                data-testid="tx-tool-name"
                className={failed ? "tx-name tx-err" : "tx-name"}
              >
                <Hi text={call.name} q={q} />
              </span>
              {call.arg === null ? null : (
                <span
                  data-testid="tx-tool-arg"
                  className="tx-arg"
                  data-truncate={call.whole ?? call.arg}
                >
                  <Hi text={call.arg} q={q} />
                </span>
              )}
            </span>
          </div>
          {open ? (
            <div data-testid="tx-call-fold">
              {call.raw === null ? null : (
                <div className="tx-res">
                  <pre data-testid="tx-args" className="tx-out">
                    <Hi text={call.raw} q={q} />
                  </pre>
                </div>
              )}
              {call.diffs.map((change, index) => (
                <div
                  key={`${change.path}-${String(index)}`}
                  className="tx-res"
                >
                  <DiffBlock change={change} q={q} />
                </div>
              ))}
              {output === null ? null : (
                <div className="tx-res">
                  <pre
                    data-testid="tx-out"
                    className={failed ? "tx-out tx-err" : "tx-out"}
                  >
                    <Hi text={output} q={q} />
                  </pre>
                </div>
              )}
              {call.parked === null ? null : (
                <div className="tx-res">
                  {t("parkedNote")}
                  {call.approvalId === null ? null : " "}
                  {call.approvalId === null ? null : (
                    <span data-testid="tx-parked-approval">
                      {t.rich("parkedApproval", {
                        approval: call.approvalId,
                        // The raw id is a detail to copy, so one click selects
                        // the whole of it.
                        code: (chunks) => (
                          <span className="select-all">{chunks}</span>
                        ),
                      })}
                    </span>
                  )}
                </div>
              )}
              <div className="tx-res flex flex-wrap items-baseline gap-ch">
                <FrameChip frame={call.frame} place={place}>
                  {t("frame", { type: call.frame.type, seq: call.frame.seq })}
                </FrameChip>
                {call.truncated ? <span>{t("truncated")}</span> : null}
              </div>
            </div>
          ) : null}
        </>
      }
      margin={
        <>
          <SubagentChip row={row} />
          {call.diffs.length > 0 ? (
            <span className={CHIP.plain}>
              <span className="text-success">+{added}</span>{" "}
              <span className="text-warning">−{removed}</span>
            </span>
          ) : null}
          {call.durationMs === null ? null : (
            <span className={failed ? CHIP.err : CHIP.plain}>
              {formatDuration(call.durationMs, locale)}
            </span>
          )}
          {call.diffs.length === 0 && lines > 1 ? (
            <span className={failed ? CHIP.err : CHIP.plain}>
              {t("lines", { count: formatCount(lines, locale) })}
            </span>
          ) : null}
          {call.parked !== null ? (
            <FrameChip frame={call.parked} place={place}>
              <span aria-hidden="true">⏸ </span>
              {t("parked", { seq: call.parked.seq })}
            </FrameChip>
          ) : call.pending ? (
            <span className={CHIP.plain}>
              {live ? t("running") : t("noResult")}
            </span>
          ) : null}
          {call.gates.map((gate) => (
            <GateChip
              key={`${gate.frame.chainRef ?? ""}:${gate.frame.seq}`}
              gate={gate}
              place={place}
            />
          ))}
          <Fold
            open={open}
            label={open ? t("hideCall") : t("showCall")}
            closedGlyph="⋯"
            onToggle={toggle}
          />
        </>
      }
    />
  );
}

/** A cost chip, with the basis that says who observed it as its title. */
function CostChip({
  value,
  tone,
  prefix,
}: {
  value: Cost;
  tone: "cost" | "burn";
  prefix?: string;
}) {
  const t = useTranslations("run.transcript");
  return (
    <span className={CHIP[tone]} title={value.basis ?? t("basisNotRecorded")}>
      {prefix === undefined ? null : `${prefix} `}
      <Money value={value} precision="exact" />
    </span>
  );
}

function UsageRow({
  row,
  place,
  pause,
}: {
  row: Extract<FeedRow, { kind: "usage" }>;
  place: Place;
  pause: ReactNode;
}) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const { usage } = row;
  const counts = [
    usage?.inputUncached == null
      ? null
      : t("tokensIn", { count: formatCount(usage.inputUncached, locale) }),
    usage?.cacheRead == null
      ? null
      : t("tokensCache", { count: formatCount(usage.cacheRead, locale) }),
    usage?.cacheWrite == null
      ? null
      : t("tokensCacheWrite", { count: formatCount(usage.cacheWrite, locale) }),
    usage?.output == null
      ? null
      : t("tokensOut", { count: formatCount(usage.output, locale) }),
  ].filter((part): part is string => part !== null);
  const line = [t("usage"), row.model, ...counts]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return (
    <Cells
      testId="tx-usage"
      pause={pause}
      line={
        <div className="tx-ln tx-quiet truncate" data-truncate={line}>
          {/* The same line, with the model's maker's mark before its name (#5297). */}
          {t("usage")}
          {row.model === null ? null : (
            <>
              {" · "}
              <ProviderMark
                model={row.model}
                size={14}
                className="mr-1 align-middle"
              />
              {row.model}
            </>
          )}
          {counts.map((count) => ` · ${count}`).join("")}
        </div>
      }
      margin={
        <>
          <SubagentChip row={row} />
          {row.effort === null ? null : (
            <span data-testid="step-effort" className={CHIP.plain}>
              {t("effort", { effort: row.effort })}
            </span>
          )}
          {usage?.reasoning == null || usage.reasoning === 0 ? null : (
            <span data-testid="step-thinking-tokens" className={CHIP.plain}>
              {t("thinkingTokens", {
                count: formatCount(usage.reasoning, locale),
              })}
            </span>
          )}
          {row.cost === null ? null : <CostChip value={row.cost} tone="cost" />}
          {row.spent === null ? null : (
            <CostChip value={row.spent} tone="burn" prefix="Σ" />
          )}
          <FrameChip frame={row.frame} place={place}>
            {t("frame", { type: row.frame.type, seq: row.frame.seq })}
          </FrameChip>
        </>
      }
    />
  );
}

function RecallRow({
  row,
  q,
  open,
  onToggle,
  place,
  pause,
}: Omit<RowProps, "row"> & { row: Extract<FeedRow, { kind: "recall" }> }) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const { recall } = row;
  const heading = [
    t("recall"),
    recall.count === null
      ? null
      : recall.unit === "frames"
        ? t("recallFrames", { count: recall.count })
        : t("recallItems", { count: formatCount(recall.count, locale) }),
    recall.tokens === null
      ? null
      : t("recallTokens", { count: formatCount(recall.tokens, locale) }),
    recall.cut === null
      ? null
      : t("recallCut", { count: formatCount(recall.cut, locale) }),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  // Closed, the heading is the whole row; what reached the model opens under
  // it. The server states each item's outcome; the cuts are counted in the
  // heading and listed on the Context tab.
  const reached = recall.items.filter((item) => item.outcome === "included");
  const foldable = reached.length > 0;
  const toggle = () => {
    onToggle(row.key);
  };
  return (
    <Cells
      testId="tx-recall"
      pause={pause}
      line={
        <>
          <div
            data-testid="tx-recall-heading"
            className={`tx-ln tx-recall truncate ${foldable ? "cursor-pointer" : ""}`}
            onClick={foldable ? lineClick(toggle) : undefined}
          >
            <span aria-hidden="true">◉ </span>
            {heading}
          </div>
          {open && foldable ? (
            <div className="tx-res">
              <div data-testid="tx-recall-items" className="tx-recall-items">
                {reached.map((item, index) => (
                  <RecallItem
                    // A manifest names each item once; the index keeps two
                    // unnamed items apart.
                    key={`${item.kind}-${item.label}-${String(index)}`}
                    item={item}
                    q={q}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </>
      }
      margin={
        <>
          <FrameChip frame={row.frame} place={place}>
            {t("frame", { type: row.frame.type, seq: row.frame.seq })}
          </FrameChip>
          <SafeLink
            to={routes.run(place.org, place.ws, place.runId, {
              tab: "context",
            })}
            className={CHIP.link}
          >
            {t("openContext")}
          </SafeLink>
          {foldable ? (
            <Fold
              open={open}
              label={open ? t("hideRecall") : t("showRecall")}
              closedGlyph="⋯"
              onToggle={toggle}
            />
          ) : null}
        </>
      }
    />
  );
}

function RecallItem({
  item,
  q,
}: {
  item: { kind: string; label: string; tokens: number | null };
  q: string;
}) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  return (
    <>
      <span>{item.kind}</span>
      <span className="truncate">
        <Hi text={item.label} q={q} />
      </span>
      <span className="text-right tabular-nums">
        {item.tokens === null
          ? ""
          : t("recallTokens", { count: formatCount(item.tokens, locale) })}
      </span>
    </>
  );
}

function SealRow({
  row,
  q,
  place,
  sealedAt,
  pause,
}: {
  row: Extract<FeedRow, { kind: "seal" }>;
  q: string;
  place: Place;
  /** The run's seal, when this is its last stop frame and the run is sealed. */
  sealedAt: string | null;
  pause: ReactNode;
}) {
  const t = useTranslations("run.transcript");
  const format = useFormatter();
  return (
    <Cells
      pause={pause}
      line={
        <div className="tx-ln flex min-w-0 items-baseline gap-ch">
          <span className="tx-seal flex-none">
            {sealedAt === null
              ? t("stopped")
              : t("sealedAt", {
                  time: format.dateTime(new Date(sealedAt), {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hourCycle: "h23",
                  }),
                })}
          </span>
          {row.label === null ? null : (
            <span className="tx-dim min-w-0 truncate" data-truncate={row.label}>
              <Hi text={closedLine(row.label)} q={q} />
            </span>
          )}
        </div>
      }
      margin={
        <FrameChip frame={row.frame} place={place}>
          {t("frame", { type: row.frame.type, seq: row.frame.seq })}
        </FrameChip>
      }
    />
  );
}

function EventRow({
  row,
  q,
  open,
  onToggle,
  place,
  pause,
}: Omit<RowProps, "row"> & { row: Extract<FeedRow, { kind: "event" }> }) {
  const t = useTranslations("run.transcript");
  const line = row.text === null ? "" : closedLine(row.text);
  const foldable = line !== "";
  const toggle = () => {
    onToggle(row.key);
  };
  return (
    <Cells
      pause={pause}
      line={
        <>
          <div
            className="tx-ln tx-call"
            data-state={row.failed ? "err" : undefined}
          >
            {row.failed ? (
              <span aria-hidden="true" className="tx-x">
                ✗
              </span>
            ) : null}
            <span
              className={`tx-head ${foldable ? "" : "cursor-auto"}`}
              onClick={foldable ? lineClick(toggle) : undefined}
            >
              <span className={row.failed ? "tx-name tx-err" : "tx-name"}>
                <Hi text={row.name} q={q} />
              </span>
              {foldable ? (
                <span
                  data-testid="tx-event-line"
                  className="tx-arg tx-dim"
                  data-truncate={line}
                >
                  <Hi text={line} q={q} />
                </span>
              ) : null}
            </span>
          </div>
          {open && foldable && row.text !== null ? (
            <div className="tx-res">
              <pre
                data-testid="tx-event-text"
                className={row.failed ? "tx-out tx-err" : "tx-out"}
              >
                <Hi text={row.text} q={q} />
              </pre>
            </div>
          ) : null}
        </>
      }
      margin={
        <>
          <SubagentChip row={row} />
          {row.gates.map((gate) => (
            <GateChip
              key={`${gate.frame.chainRef ?? ""}:${gate.frame.seq}`}
              gate={gate}
              place={place}
            />
          ))}
          {row.gates.length > 0 ? null : (
            <FrameChip frame={row.frame} place={place}>
              {t("frame", { type: row.frame.type, seq: row.frame.seq })}
            </FrameChip>
          )}
          {foldable ? (
            <Fold
              open={open}
              label={open ? t("showLess") : t("showFull")}
              closedGlyph="⋯"
              onToggle={toggle}
            />
          ) : null}
        </>
      }
    />
  );
}

// ── Chips and transport ─────────────────────────────────────────────────────

/** `TX_HUE`, as the chip's accessible hue is its word: the dot only repeats it. */
function KindChips({
  counts,
  floor,
  on,
  errors,
  errorsOnly,
  onGroup,
  onAll,
  onErrors,
}: {
  /** The server's count per chip over the whole run; null when the read carried none. */
  counts: TranscriptCounts["kinds"] | null;
  /**
   * The run has more frames than the read could fold, so each count is how
   * many at least, and reads `12+` rather than a total the record has not
   * shown.
   */
  floor: boolean;
  on: Record<FeedGroup, boolean>;
  /** The server's count of failed or refused entries; null when the read carried none. */
  errors: number | null;
  errorsOnly: boolean;
  onGroup: (group: FeedGroup) => void;
  onAll: (value: boolean) => void;
  onErrors: () => void;
}) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const anyOff = FEED_GROUPS.some((group) => !on[group]);
  const count = (n: number): string =>
    floor
      ? t("countFloor", { count: formatCount(n, locale) })
      : formatCount(n, locale);
  return (
    <div
      role="group"
      aria-label={t("chipsLabel")}
      data-testid="transcript-chips"
      className={txKinds}
    >
      {FEED_GROUPS.map((group) => (
        <button
          key={group}
          type="button"
          data-testid={`chip-${group}`}
          aria-pressed={on[group]}
          onClick={() => {
            onGroup(group);
          }}
          className={txKind}
        >
          <span
            data-dot=""
            aria-hidden="true"
            className={`size-2 flex-none rounded-[2px] ${on[group] ? DOT[group].on : DOT[group].off}`}
          />
          <span>{t(`chip.${group}`)}</span>
          {counts === null ? null : (
            <span data-testid={`chip-${group}-count`} className={txKindCount}>
              {count(counts[group])}
            </span>
          )}
        </button>
      ))}
      <button
        type="button"
        data-testid="chip-all"
        onClick={() => {
          onAll(anyOff);
        }}
        className={txKindAll}
      >
        {anyOff ? t("all") : t("none")}
      </button>
      <button
        type="button"
        data-testid="chip-errors"
        aria-pressed={errorsOnly}
        title={errors === 0 ? t("errorsNone") : t("errorsHint")}
        onClick={onErrors}
        className={txKindErrors}
      >
        <span>{t("errors")}</span>
        {errors !== null && errors > 0 ? (
          <span data-testid="chip-errors-count" className={txKindCount}>
            {count(errors)}
          </span>
        ) : null}
      </button>
    </div>
  );
}

function Burn({ spent, total }: { spent: Cost | null; total: Cost | null }) {
  const t = useTranslations("run.transcript");
  if (total === null) {
    return (
      <span data-testid="tx-burn" className={txBurn}>
        <span>{t("burn")}</span>
        <span>{t("burnNotRecorded")}</span>
      </span>
    );
  }
  const share = spent === null ? null : ratioOfMicros(spent, total);
  return (
    <span data-testid="tx-burn" className={txBurn}>
      <span>{t("burn")}</span>
      <span className="h-1 w-30 overflow-hidden rounded-[2px] bg-hl">
        <i
          aria-hidden="true"
          className="block h-full bg-info transition-[width] duration-200"
          style={{ width: share === null ? "0%" : ratioWidth(share) }}
        />
      </span>
      <b className="font-semibold text-foreground">
        {spent === null ? (
          t("burnNone")
        ) : (
          <Money value={spent} precision="cents" />
        )}
      </b>
      <span>
        {t("burnOf")} <Money value={total} precision="cents" />{" "}
        {total.basis ?? t("basisNotRecorded")}
      </span>
    </span>
  );
}

// ── The view ────────────────────────────────────────────────────────────────

/** A row drawn, its place in the rows shown, and the subagent rows under it. */
type Drawn = { row: FeedRow; index: number; children: Drawn[] };

/**
 * The rows shown, with each subagent's rows moved under the row of the entry
 * that spawned it (the entry's `parentKey`, which the server resolves), so
 * the subagent's work reads as that call's and not as the run's own. The
 * server places a subagent's entries after the call that spawned them, so
 * the order on screen is the order of the list. A subagent's own subagent
 * nests under its call the same way. A row whose parent is not shown (a chip
 * hid it, or the transport has not reached it) draws at the top level rather
 * than disappearing.
 */
function nest(rows: readonly FeedRow[]): Drawn[] {
  const top: Drawn[] = [];
  // The first row drawn for each entry, which that entry's children go under.
  const byEntry = new Map<string, Drawn>();
  rows.forEach((row, index) => {
    const drawn: Drawn = { row, index, children: [] };
    const parent = row.parent === null ? undefined : byEntry.get(row.parent);
    if (parent === undefined) top.push(drawn);
    else parent.children.push(drawn);
    if (!byEntry.has(row.entry)) byEntry.set(row.entry, drawn);
  });
  return top;
}

/**
 * Every chip on, except where the URL's `?kinds=` named the ones it wanted,
 * or said `none`. `policy` and `errors` name no chip here (a decision is the
 * ⚖ chip on its call, and errors is the toggle), so a link carrying only
 * those opens every chip.
 */
function initialGroups(kinds: KindFilter): Record<FeedGroup, boolean> {
  if (kinds === "none") return eachGroup(() => false);
  const asked = new Set<string>(kinds);
  const named = FEED_GROUPS.filter((group) => asked.has(group));
  return eachGroup((group) => named.length === 0 || named.includes(group));
}

/** One value per chip, in the chips' order. */
function eachGroup<T>(value: (group: FeedGroup) => T): Record<FeedGroup, T> {
  return {
    prompt: value("prompt"),
    responses: value("responses"),
    thinking: value("thinking"),
    tools: value("tools"),
    usage: value("usage"),
    recall: value("recall"),
    seal: value("seal"),
  };
}

export function TranscriptView({
  transcript,
  entries: first,
  from,
  run,
  kinds,
  org,
  ws,
  runId,
}: {
  /**
   * `cursor` is set when entries lie past this read: more can be paged in.
   * `before` is set on a read from the run's end while entries lie ahead of
   * it. `counts` is the whole run's, counted by the server. `frameCursor` is
   * where the live stream opens.
   */
  transcript: Pick<
    RunTranscript,
    "complete" | "cursor" | "before" | "counts" | "frameCursor"
  >;
  /** The page's entries at `steps`, at least one. */
  entries: Frames;
  /**
   * Where the page's read opened: `start` for a run the view replays, `end`
   * for a live run it follows. The view keeps the mode it opened in.
   */
  from: TranscriptFrom;
  run: TranscriptRun;
  /** The URL's `?kinds=`, which sets the chips a link opens with. */
  kinds: KindFilter;
} & Place) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const navigate = useNavigate();
  const place = useMemo(() => ({ org, ws, runId }), [org, ws, runId]);
  const live = run.status === "live";
  // Where the view reads from, fixed when it opens. A view that opened at
  // the run's end pages up from there; one that opened at its first entry
  // pages forward as it plays. A live view keeps its end once the run seals.
  const [mode] = useState(from);
  const tail = mode === "end";
  // The whole run's counts, from a read that began at the run's first frame:
  // the first page, and every page read from the end or before a cursor. A
  // page read after a cursor reads a window of the run and carries none, so
  // each chip keeps its whole-run count until a read counts the run again
  // (#3823, D6).
  const [counts, setCounts] = useState<TranscriptCounts | null>(
    transcript.counts,
  );

  // The entries and the cursor as the last read left them. A ref as well as
  // state, because an append needs the new length before React has committed
  // the state that carries it, and this is the only place that appends.
  const heldRef = useRef<Frames>(first);
  const cursorRef = useRef<string | null>(transcript.cursor);
  const readingRef = useRef(false);
  // A signal that arrived mid-read: set when a caller finds readingRef
  // already true, so the request in flight cannot see it. The finally block
  // below checks it and runs one more tail read once that request settles,
  // so a frame landing during an active read is never dropped.
  const pendingReadRef = useRef(false);
  // Latest loadMore, so the finally block can request a follow-up without
  // closing over the useCallback identity (React Compiler refuses that).
  const loadMoreRef = useRef<() => Promise<void>>(async () => {});
  const [entries, setEntries] = useState<Frames>(first);
  const [cursor, setCursor] = useState<string | null>(transcript.cursor);
  const [complete, setComplete] = useState(transcript.complete);
  const [reading, setReading] = useState(false);
  const [pageFailure, setPageFailure] = useState<PageFailure | null>(null);
  // The point to read the page ahead of the first entry held, for a view
  // that opened at the run's end; null once it holds the run's first entry.
  const firstBefore = tail ? (transcript.before ?? null) : null;
  const beforeRef = useRef<string | null>(firstBefore);
  const [before, setBefore] = useState<string | null>(firstBefore);
  const olderRef = useRef(false);
  const [readingOlder, setReadingOlder] = useState(false);
  // The tail read a view that opened at the run's end makes once the seal
  // re-reads the page from the run's first entry. A count, so each seal asks.
  const [retail, setRetail] = useState(0);

  // The page read the run again: the seal refreshes it, and so do the run
  // controls. That read is the record as it stands, in the order the server
  // placed it, so it replaces what this view had paged in, and its counts
  // replace the chips'. A subagent frame that landed before the cursor
  // reaches the tail read too (#4083), and this read places it the same way.
  // Entries this view read outside the page's own bounds stay, and so do the
  // cursors that reached them.
  const [readFrom, setReadFrom] = useState(first);
  if (readFrom !== first) {
    setReadFrom(first);
    setCounts(transcript.counts);
    if (from !== mode) {
      // The seal re-read the run from its first entry, and this view holds
      // its end. It reads its own end again instead (`retail` below).
      setComplete(transcript.complete);
      setRetail((count) => count + 1);
    } else {
      const rebased = rebaseEntries(first, entries);
      if (rebased === null) {
        // A tail read that shares nothing with what the view holds: the run
        // moved more than a page past it. The view takes the new tail.
        setEntries(first);
        setCursor(transcript.cursor);
        setComplete(transcript.complete);
        setBefore(firstBefore);
      } else {
        setEntries(rebased);
        // The rebase places the fresh read's own entries, so a list that
        // ends on the read's last entry holds nothing past it, and one that
        // opens on its first holds nothing ahead of it.
        if (rebased.at(-1) === first.at(-1)) {
          setCursor(transcript.cursor);
          setComplete(transcript.complete);
        }
        if (tail && rebased[0] === first[0]) setBefore(firstBefore);
      }
    }
  }
  // The refs follow the state a rebase set. A page read sets both itself,
  // before the render, so an append in flight never merges onto a stale list.
  useEffect(() => {
    heldRef.current = entries;
  }, [entries]);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);
  useEffect(() => {
    beforeRef.current = before;
  }, [before]);

  const [on, setOn] = useState(() => initialGroups(kinds));
  const [errorsOnly, setErrorsOnly] = useState(
    () => kinds !== "none" && kinds.includes("errors"),
  );
  const [query, setQuery] = useState("");
  const [thinking, setThinking] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  // The search the server answered: the entries that hold the query, and
  // what it found across the run. Null while no search is in force.
  const [found, setFound] = useState<Found | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  const wanted = searchText(query);
  // A search is in force once its answer is in; until then the rows are the
  // run's, so a reader never sees a stale search's rows under a new query.
  const searching = found !== null && found.query === wanted;
  const q = searching ? wanted.toLowerCase() : "";
  const paced = !searching;

  const rows = useMemo(
    () => feedOf(searching ? found.entries : entries),
    [searching, found, entries],
  );

  // The query goes to the server once the reader stops typing (ADR-182): a
  // search can read every body a run kept, so a keystroke is not a read.
  // An empty query ends the search.
  useEffect(() => {
    if (wanted === "") return;
    let current = true;
    const timer = setTimeout(() => {
      void readTranscriptPage(org, ws, runId, "steps", {
        text: "full",
        query: wanted,
      })
        .then((read) => {
          if (!current) return;
          if (!read.ok) {
            setSearchFailed(true);
            return;
          }
          setSearchFailed(false);
          setFound({
            query: wanted,
            entries: read.value.entries,
            cursor: read.value.cursor,
            search: read.value.search,
          });
        })
        .catch(() => {
          if (current) setSearchFailed(true);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [wanted, org, ws, runId]);

  const visible = useMemo(
    () =>
      rows.filter((row) => {
        if (errorsOnly) return row.failed;
        return row.group === null || on[row.group];
      }),
    [rows, errorsOnly, on],
  );
  const total = visible.length;

  // The transport. `pos` is how many rows are shown; null holds the end, so
  // a live run's new rows appear as they land. A view that opened at the
  // run's first entry plays from its first row as the page opens (#4427).
  const [pos, setPos] = useState<number | null>(tail ? null : 0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<Speed>(1);
  const at = paced ? Math.min(pos ?? total, total) : total;
  // A replay with pages still unread waits at the last row it holds while
  // the next page is read, as a live view waits for the run.
  const waits = live || (!tail && cursor !== null);
  const isPlaying = playing && paced && (waits || at < total);
  const done = !isPlaying && at >= total && !waits;
  // A replay that has played every row it will read holds the end, as a live
  // view does, so a row that a later read of the page adds is drawn.
  const holdsEnd = tail || !waits;
  const feedRef = useRef<HTMLDivElement>(null);
  // True while the reader is at the feed's foot, so new rows keep it there.
  const followRef = useRef(true);
  // The distance from the feed's foot to its scroll position before a page
  // was laid above the rows, so the rows the reader was on stay put.
  const anchorRef = useRef<number | null>(null);

  // Rows laid ahead of the first one shown (a page ahead, or a chip turned
  // on) move a held position down by as many, so the rows shown stay shown.
  // A search draws its own rows and holds no position, so it moves nothing.
  const [shownFrom, setShownFrom] = useState(visible[0]?.key ?? null);
  const firstKey = searching ? shownFrom : (visible[0]?.key ?? null);
  if (shownFrom !== firstKey) {
    setShownFrom(firstKey);
    const moved =
      shownFrom === null
        ? -1
        : visible.findIndex((row) => row.key === shownFrom);
    if (pos !== null && moved > 0) setPos(pos + moved);
  }

  /**
   * Read the page past the cursor and append it. Nothing already on screen is
   * replaced, so the scroll position and the playhead survive the read.
   *
   * A replay reads one page ahead of its playhead. A live view catches up
   * with the run: a coalesced stream signal is only "there is more to read",
   * not a page count, so when a page comes back full and still carries a
   * resume cursor, this drains the next page in the same call so the view
   * does not stall hundreds of entries behind the head until another frame
   * lands.
   */
  const readPending = () => pendingReadRef.current;

  const loadMore = useCallback(async (): Promise<void> => {
    // A read already in flight cannot see a frame that lands while it runs,
    // so record the signal and loop below for a follow-up read once that
    // request settles, rather than dropping it or calling this function
    // recursively (which React Compiler cannot memoize safely).
    if (readingRef.current) {
      pendingReadRef.current = true;
      return;
    }
    readingRef.current = true;
    setReading(true);
    // True when the last page was full and still has a cursor: keep reading
    // in this same loadMore rather than waiting for another stream signal.
    // Declared without an initializer on purpose: every iteration clears it
    // first (a stale `true` would spin forever on empty pages), so an
    // initializer here would be written and never read.
    let drainMore: boolean;
    try {
      do {
        pendingReadRef.current = false;
        drainMore = false;
        // A sealed run stops when the page answers no cursor. A live run
        // must keep a resume cursor from the handler so SSE can ask for
        // the next page.
        if (cursorRef.current === null) return;
        // The chips show and hide rows already read, so every page is read
        // whole, at the zoom and text the page read. A live view reads at
        // the most a page holds: every page costs a whole refold on the
        // server (#4340), so fewer, larger pages catch up sooner.
        const read = await readTranscriptPage(org, ws, runId, "steps", {
          after: cursorRef.current,
          text: "full",
          limit: tail ? TRANSCRIPT_ENTRY_MAX : TRANSCRIPT_PAGE,
        });
        if (!read.ok) {
          setPageFailure(read);
          return;
        }
        setPageFailure(null);
        const pageEntries = read.value.entries;
        cursorRef.current = read.value.cursor;
        setCursor(read.value.cursor);
        setComplete(read.value.complete);
        // Only a read from the run's first frame counts the whole run.
        if (read.value.counts !== null) setCounts(read.value.counts);
        if (pageEntries.length === 0) {
          // Nothing new: stop draining. A mid-read signal still schedules
          // one follow-up via pendingReadRef / the finally block.
          continue;
        }
        // A page can send again an entry the view holds, grown since it was
        // sent; it replaces its row rather than drawing the step twice. A
        // subagent's entry that landed before the cursor goes under its call,
        // or, ahead of the tail this view holds, waits for the page ahead.
        const next: Frames = tail
          ? mergeTail(heldRef.current, pageEntries)
          : mergeEntries(heldRef.current, pageEntries);
        heldRef.current = next;
        setEntries(next);
        // Full page with a resume cursor means more history is waiting.
        // Drain it now. A short page or a null cursor ends the drain.
        drainMore =
          tail &&
          pageEntries.length >= TRANSCRIPT_ENTRY_MAX &&
          cursorRef.current !== null;
        // Read through a function rather than the ref directly: the ref can
        // flip true from the early-return branch above while this `await`
        // is in flight, but TS's flow analysis cannot see that concurrent
        // write and would otherwise narrow the property to always `false`.
      } while (readPending() || drainMore);
    } catch {
      setPageFailure({
        ok: false,
        reason: "unavailable",
        code: "unanswered",
      });
    } finally {
      readingRef.current = false;
      setReading(false);
      if (pendingReadRef.current) {
        pendingReadRef.current = false;
        void loadMoreRef.current();
      }
    }
  }, [org, runId, ws, tail]);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  /**
   * Read the page ahead of the first entry the view holds and lay it above.
   * The rows the reader was looking at stay where they were on screen.
   */
  const loadOlder = useCallback(async (): Promise<void> => {
    const ahead = beforeRef.current;
    if (ahead === null || olderRef.current) return;
    olderRef.current = true;
    setReadingOlder(true);
    try {
      const read = await readTranscriptPage(org, ws, runId, "steps", {
        before: ahead,
        text: "full",
        limit: TRANSCRIPT_PAGE,
      });
      if (!read.ok) {
        setPageFailure(read);
        return;
      }
      setPageFailure(null);
      const feed = feedRef.current;
      anchorRef.current =
        feed === null ? null : feed.scrollHeight - feed.scrollTop;
      const next = prependEntries(heldRef.current, read.value.entries);
      heldRef.current = next;
      setEntries(next);
      beforeRef.current = read.value.before ?? null;
      setBefore(read.value.before ?? null);
      if (read.value.counts !== null) setCounts(read.value.counts);
    } catch {
      setPageFailure({ ok: false, reason: "unavailable", code: "unanswered" });
    } finally {
      olderRef.current = false;
      setReadingOlder(false);
    }
  }, [org, runId, ws]);

  // A page laid above the rows keeps the reader's place: the distance from
  // the foot is what it was, so the rows on screen stay on screen.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const feed = feedRef.current;
    if (anchor === null || feed === null) return;
    anchorRef.current = null;
    feed.scrollTop = feed.scrollHeight - anchor;
  }, [entries]);

  /**
   * The seal re-read the page from the run's first entry, and this view
   * holds the run's end, so it reads its own end again, as many entries as
   * it holds, and rebases onto that read. A subagent entry the tail reads
   * could not reach lands under its call this way (#4083).
   */
  const readEnd = useCallback(async (): Promise<void> => {
    const holding = heldRef.current.length;
    try {
      const read = await readTranscriptPage(org, ws, runId, "steps", {
        from: "end",
        text: "full",
        limit: Math.min(
          TRANSCRIPT_ENTRY_MAX,
          Math.max(TRANSCRIPT_PAGE, holding),
        ),
      });
      if (!read.ok) {
        setPageFailure(read);
        return;
      }
      const [lead, ...rest] = read.value.entries;
      if (lead === undefined) return;
      const fresh: Frames = [lead, ...rest];
      const rebased = rebaseEntries(fresh, heldRef.current) ?? fresh;
      heldRef.current = rebased;
      setEntries(rebased);
      if (read.value.counts !== null) setCounts(read.value.counts);
      setComplete(read.value.complete);
      if (rebased.at(-1) === fresh.at(-1)) {
        cursorRef.current = read.value.cursor;
        setCursor(read.value.cursor);
      }
      if (rebased[0] === fresh[0]) {
        beforeRef.current = read.value.before ?? null;
        setBefore(read.value.before ?? null);
      }
    } catch {
      setPageFailure({ ok: false, reason: "unavailable", code: "unanswered" });
    }
  }, [org, runId, ws]);
  useEffect(() => {
    if (retail === 0) return;
    const timer = setTimeout(() => {
      void readEnd();
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [retail, readEnd]);

  // A replay reads the next page once playback passes half of what it
  // holds, so the rows ahead are in before the playhead reaches them. The
  // playhead is a row, so its place is the entry that row draws. Each length
  // of the held list asks once; the "more" control retries a page that
  // failed. The timer keeps the read out of the effect's own pass, as the
  // search's does.
  const entryIndex = useMemo(
    () => new Map(entries.map((entry, index) => [entryKey(entry), index])),
    [entries],
  );
  const playedTo =
    at >= total
      ? entries.length
      : (entryIndex.get(visible[at]?.entry ?? "") ?? 0);
  const halfway =
    !tail && paced && cursor !== null && playedTo * 2 >= entries.length;
  const askedRef = useRef(0);
  const heldCount = entries.length;
  useEffect(() => {
    if (!halfway || askedRef.current >= heldCount) return;
    const timer = setTimeout(() => {
      askedRef.current = heldCount;
      void loadMore();
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [halfway, heldCount, loadMore]);

  /**
   * The next page of a search's matches. The server pages matches on the
   * same cursor as any other read, so the page carries on from the last
   * match read.
   */
  const moreMatches = async (): Promise<void> => {
    if (!searching || found.cursor === null || reading) return;
    setReading(true);
    try {
      const read = await readTranscriptPage(org, ws, runId, "steps", {
        after: found.cursor,
        text: "full",
        query: found.query,
      });
      if (!read.ok) {
        setPageFailure(read);
        return;
      }
      setPageFailure(null);
      setFound((prev) =>
        prev === null || prev.query !== found.query
          ? prev
          : {
              ...prev,
              entries: mergeEntries(prev.entries, read.value.entries),
              cursor: read.value.cursor,
            },
      );
    } catch {
      setPageFailure({ ok: false, reason: "unavailable", code: "unanswered" });
    } finally {
      setReading(false);
    }
  };

  // A live run reads its tail when the stream says a frame landed. The
  // stream stays open while the viewer is paused: the run keeps recording,
  // and the count beside the transport says how far behind the viewer is.
  // It opens after the last frame the transcript folded, so it signals only
  // frames the page has not read.
  //
  // The page's stale reading (`isStale`) is as of its read. The header and
  // the run controls read it too, and this component owns neither, so the
  // page is read again when the stream says the reading changed: the row the
  // route sends when it opens disagrees, or a frame lands while the page
  // reads stale, which means the host is back.
  const stale = isStale(run);
  const staleRefresh = useStaleRefresh(stale);
  const stream = useRunStream({
    url: `/api/v1/${encodeURIComponent(org)}/${encodeURIComponent(
      ws,
    )}/runs/${encodeURIComponent(runId)}/stream`,
    after: transcript.frameCursor ?? null,
    enabled: live,
    onFrames: () => {
      staleRefresh.onFrames();
      void loadMore();
    },
    onRun: staleRefresh.onRun,
  });

  // The seal changes the header, the badges and the record actions, none of
  // which this component owns, so the page is re-read once when it happens.
  useEffect(() => {
    if (stream === "sealed") navigate.refresh();
  }, [stream, navigate]);

  // Playback reveals the next row after the recorded gap to it. A live view
  // that reaches the last row holds the end, so rows appear as they land; a
  // replay holds a count, so a page read ahead does not show all at once.
  useEffect(() => {
    if (!isPlaying || at >= total) return;
    const next = visible[at];
    const previous = at === 0 ? 0 : (visible[at - 1]?.elapsedMs ?? 0);
    const gap = (next?.elapsedMs ?? previous) - previous;
    const timer = setTimeout(
      () => {
        setPos(at + 1 >= total && holdsEnd ? null : at + 1);
      },
      paceMs(gap, speed),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [isPlaying, at, total, visible, speed, holdsEnd]);

  // Keep the newest row in view while playing or following, unless the
  // reader has scrolled away from the foot.
  useEffect(() => {
    if (!isPlaying || !followRef.current) return;
    const feed = feedRef.current;
    if (feed !== null) feed.scrollTop = feed.scrollHeight;
  }, [isPlaying, at]);

  // The reader's place: at the foot, new rows keep them there. Near the top
  // of a view that opened at the run's end, the page ahead is read.
  const onFeedScroll = () => {
    const feed = feedRef.current;
    if (feed === null) return;
    followRef.current =
      feed.scrollHeight - feed.scrollTop - feed.clientHeight <= FOLLOW_PX;
    if (tail && !searching && feed.scrollTop <= OLDER_PX) void loadOlder();
  };

  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const seek = (next: number) => {
    const clamped = Math.max(0, Math.min(total, next));
    // At the end of a live run, holding the end is following it.
    const follows = (live && isPlaying) || !waits;
    setPos(clamped >= total && follows ? null : clamped);
  };
  const step = (by: number) => {
    setPlaying(false);
    setPos(Math.max(0, Math.min(total, at + by)));
  };
  const playPause = () => {
    if (done) {
      followRef.current = true;
      setPos(0);
      setPlaying(true);
      return;
    }
    if (isPlaying) {
      // Pausing holds the rows shown; a live run's next rows wait past it.
      setPos(at);
      setPlaying(false);
      return;
    }
    setPlaying(true);
  };

  // The answer is the last thing the agent said, once the run has stopped.
  const answer = live
    ? -1
    : visible.reduce(
        (last, row, index) => (row.kind === "text" ? index : last),
        -1,
      );
  const lastSeal = visible.reduce(
    (last, row, index) => (row.kind === "seal" ? index : last),
    -1,
  );
  // What the run had spent by the last row shown, from the contract's own
  // running total, and what it spent in all.
  const spentTotal = entries[entries.length - 1]?.cumulativeCost ?? null;
  const spent =
    at >= total
      ? spentTotal
      : visible
          .slice(0, at)
          .reduceRight<Cost | null>((found, row) => found ?? row.spent, null);

  const meta = [
    run.agentKey,
    run.model?.slug ?? null,
    run.turns === null ? null : t("turns", { count: run.turns }),
    t("steps", { count: run.steps }),
    // The server's count, which the Transcript tab's own count reads too.
    t("entries", { count: counts?.entries ?? rows.length }),
  ].filter((part): part is string => part !== null);

  const empty = errorsOnly
    ? t("emptyErrors")
    : searching
      ? t("emptySearch")
      : rows.length === 0
        ? t("emptyRows")
        : t("emptyFiltered");
  // The resume point of what is drawn: the search's matches while a search
  // is in force, else the run's.
  const drawnCursor = searching ? found.cursor : cursor;
  // A read that stopped short of the run's end counted and searched only the
  // part it read, so its counts print as floors (`12+`), as the chips do.
  const countOf = (n: number): string =>
    complete
      ? formatCount(n, locale)
      : t("countFloor", { count: formatCount(n, locale) });
  // Following a live run: the stream reads the tail as frames land, so the
  // footer offers no page to read. Each tail read reads a window from the
  // cursor, so a live run past the read's frame cap is followed past it
  // (#3823), and the footer needs no line for a prefix that stopped growing.
  const following =
    live && (stream === "connecting" || stream === "open") && !searching;

  const footer =
    stream === "denied"
      ? t("followDenied")
      : stream === "lost"
        ? t("followLost")
        : stream === "sealed"
          ? t("followSealed")
          : following
            ? null
            : drawnCursor !== null
              ? t("loadedMore", {
                  count: formatCount(
                    searching ? found.entries.length : entries.length,
                    locale,
                  ),
                })
              : !complete
                ? t("cut", {
                    // While a search is in force the rows are its matches,
                    // so the line counts those, not the run's entries.
                    count: formatCount(
                      searching ? found.entries.length : entries.length,
                      locale,
                    ),
                  })
                : null;

  // The recorded pause before each row, from the row before it in the run.
  // A chip that hides rows hides no time, so the row before it on screen
  // would overstate the pause. A search's matches are not the run's order of
  // rows, so a search notes none.
  const waitedMs = new Map<string, number>();
  if (!searching) {
    rows.forEach((row, index) => {
      const prior = rows[index - 1];
      if (prior !== undefined) {
        waitedMs.set(row.key, row.elapsedMs - prior.elapsedMs);
      }
    });
  }

  // One drawn row, with the subagent rows under it drawn inside it, a step
  // deeper. The margin notes a recorded pause of a minute or more before it.
  const drawRow = ({ row, index, children }: Drawn, depth: number): ReactNode => {
    const waited = waitedMs.get(row.key) ?? 0;
    const depthStyle: StyleWithVariables = { "--depth": String(depth) };
    return (
      <div
        key={row.key}
        data-testid="tx-row"
        data-kind={row.kind}
        style={depthStyle}
      >
        <div className="tr">
          <div className="tg">
            <Clock at={row.at} elapsedMs={row.elapsedMs} />
          </div>
          <FeedRowView
            row={row}
            q={q}
            // A row whose entry the search matched opens, so the match shows;
            // its fold still closes it.
            open={
              open.has(row.key) !== (searching && row.matched) ||
              (row.kind === "thinking" && thinking)
            }
            onToggle={toggle}
            place={place}
            run={run}
            live={live}
            answer={index === answer}
            sealed={index === lastSeal && run.sealedAt !== null}
            pause={
              waited < GAP_NOTE_MS ? null : (
                <span className="mg-gap">
                  {t("waited", { time: formatDuration(waited, locale) })}
                </span>
              )
            }
          />
        </div>
        {children.length === 0 ? null : (
          <div data-testid="transcript-subagent-steps" className="tx-nest">
            {children.map((child) => drawRow(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // The scrubber's marks: the prompts and failures always, every call while
  // the rows are few enough for the marks to read. Each lands in one of
  // MARK_SLOTS places along the track, and a place draws one mark per kind.
  const marks: { kind: "user" | "tool" | "err"; slot: number }[] = [];
  const marked = new Set<string>();
  visible.forEach((row, index) => {
    const kind = row.failed
      ? "err"
      : row.kind === "prompt"
        ? "user"
        : row.kind === "tool" && total <= TOOL_MARKS_MAX
          ? "tool"
          : null;
    if (kind === null) return;
    const slot = Math.round((index / total) * MARK_SLOTS);
    const id = `${kind}:${String(slot)}`;
    if (marked.has(id)) return;
    marked.add(id);
    marks.push({ kind, slot });
  });

  const skin = skinOf(run.harness);

  return (
    <section aria-label={t("title")} data-testid="transcript" className={txs}>
      <div className={txTools}>
        <input
          type="search"
          value={query}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchLabel")}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
          }}
          className={txSearch}
        />
        {wanted === "" ? null : (
          <span
            data-testid="tx-matches"
            className="font-mono text-xs text-dim"
          >
            {searchFailed
              ? t("searchFailed")
              : !searching
                ? t("searching")
                : t("matches", {
                    shown: countOf(
                      found.search?.matched ?? found.entries.length,
                    ),
                    total: countOf(counts?.entries ?? entries.length),
                  })}
          </span>
        )}
        {searching && (found.search?.unsearched ?? 0) > 0 ? (
          <span
            data-testid="tx-unsearched"
            className="font-mono text-xs text-dim"
          >
            {t("unsearched", {
              count: found.search?.unsearched ?? 0,
            })}
          </span>
        ) : null}
        <KindChips
          counts={counts?.kinds ?? null}
          floor={!complete}
          on={on}
          errors={counts?.errors ?? null}
          errorsOnly={errorsOnly}
          onGroup={(group) => {
            setOn((prev) => ({ ...prev, [group]: !prev[group] }));
          }}
          onAll={(value) => {
            setOn(eachGroup(() => value));
          }}
          onErrors={() => {
            setErrorsOnly((prev) => !prev);
          }}
        />
      </div>
      <div role="group" aria-label={t("transportLabel")} className="rpbar">
        {paced ? (
          <>
            <button
              type="button"
              className={txButton}
              aria-label={t("rewind")}
              title={t("rewind")}
              disabled={at <= 0}
              onClick={() => {
                seek(0);
              }}
            >
              ⏮
            </button>
            <button
              type="button"
              className={txButton}
              aria-label={t("back")}
              title={t("back")}
              disabled={at <= 0}
              onClick={() => {
                step(-1);
              }}
            >
              ◀
            </button>
            <button
              type="button"
              data-testid="tx-play"
              className={txPlayButton}
              onClick={playPause}
            >
              <span aria-hidden="true">
                {done ? "▶ " : isPlaying ? "❙❙ " : "▶ "}
              </span>
              {done ? t("replay") : isPlaying ? t("pause") : t("play")}
            </button>
            <button
              type="button"
              className={txButton}
              aria-label={t("forward")}
              title={t("forward")}
              disabled={at >= total}
              onClick={() => {
                step(1);
              }}
            >
              ▶
            </button>
            <button
              type="button"
              className={txButton}
              aria-label={t("end")}
              title={t("end")}
              disabled={at >= total}
              onClick={() => {
                seek(total);
              }}
            >
              ⏭
            </button>
            <div className="rp-track">
              <div className="rp-rail" aria-hidden="true">
                <div
                  className="rp-fill"
                  style={{ width: total === 0 ? "0%" : ratioWidth(at / total) }}
                />
              </div>
              <div className="rp-marks" aria-hidden="true">
                {marks.map((mark) => (
                  <i
                    key={`${mark.kind}:${String(mark.slot)}`}
                    className={`m-${mark.kind}`}
                    style={{ left: ratioWidth(mark.slot / MARK_SLOTS) }}
                  />
                ))}
              </div>
              <input
                type="range"
                className="rp-range"
                aria-label={t("scrub")}
                aria-valuetext={t("position", {
                  at: formatCount(at, locale),
                  total: formatCount(total, locale),
                })}
                min={0}
                max={total}
                step={1}
                value={at}
                disabled={total === 0}
                onChange={(event) => {
                  seek(Number(event.currentTarget.value));
                }}
              />
            </div>
            <span className="rp-time">
              <span>
                {formatDuration(visible[at - 1]?.elapsedMs ?? 0, locale)}
              </span>
              <span>
                {formatDuration(visible[total - 1]?.elapsedMs ?? 0, locale)}
              </span>
            </span>
            <span role="group" aria-label={t("speedLabel")} className={txSeg}>
              {SPEEDS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={speed === value}
                  onClick={() => {
                    setSpeed(value);
                  }}
                  className={txSegButton}
                >
                  {t("speed", { speed: value })}
                </button>
              ))}
            </span>
            <span data-testid="transport-readout" className={txCount}>
              {t("position", {
                at: formatCount(at, locale),
                total: formatCount(total, locale),
              })}
            </span>
          </>
        ) : (
          <span className={txCount}>{t("unpaced")}</span>
        )}
        <button
          type="button"
          data-testid="expand-thinking"
          aria-pressed={thinking}
          className={`${txGhost} ml-auto`}
          onClick={() => {
            setThinking((prev) => !prev);
            setOpen(new Set());
          }}
        >
          {thinking ? t("collapseThinking") : t("expandThinking")}
        </button>
      </div>
      <div className={`term ${skin}`}>
        <div className="term-top">
          <div />
          <div data-testid="tx-runbar" className="term-bar">
            <span className="term-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="term-t">
              <b>{run.taskRef ?? runId}</b>
              {meta.map((part, index) => (
                <span key={part}>
                  {index === 0 ? null : " · "}
                  {run.model !== null && part === run.model.slug ? (
                    <ProviderMark
                      provider={run.model.provider}
                      model={part}
                      size={14}
                      className="mr-1 align-middle"
                    />
                  ) : null}
                  {part}
                </span>
              ))}
            </span>
            <span className="term-h">
              {errorsOnly ? (
                <span className={CHIP.err}>{t("errorsOnly")}</span>
              ) : null}
              {live && stream !== "denied" ? (
                run.ingressPaused === true ? (
                  <span className={CHIP.warn}>
                    <span aria-hidden="true">⏸ </span>
                    {t("paused")}
                  </span>
                ) : (
                  <span className={CHIP.ok}>
                    <span aria-hidden="true">● </span>
                    {t("live")}
                  </span>
                )
              ) : run.status === "live" ? null : (
                <span className={CHIP.plain}>{t(`status.${run.status}`)}</span>
              )}
              <Burn spent={spent} total={spentTotal} />
            </span>
          </div>
          <div />
        </div>
        <div
          ref={feedRef}
          data-testid="tx-feed"
          className="rp-body"
          onScroll={onFeedScroll}
        >
          {skin === "cu" ? null : (
            <div className="tr tr-banner">
              <div className="tg" />
              <div className="tc">
                <SkinBanner
                  skin={skin}
                  harness={run.harness}
                  model={run.model?.slug ?? null}
                  session={run.taskRef ?? runId}
                />
              </div>
              <div className="tm" />
            </div>
          )}
          {tail && before !== null && !searching ? (
            <div className="tr">
              <div className="tg" />
              <div className={`tc ${txOlder}`}>
                <button
                  type="button"
                  data-testid="transcript-older"
                  disabled={readingOlder}
                  onClick={() => {
                    void loadOlder();
                  }}
                  className={txButton}
                >
                  {readingOlder ? t("readingOlder") : t("older")}
                </button>
              </div>
              <div className="tm" />
            </div>
          ) : null}
          {total === 0 ? (
            <div className="tr">
              <div className="tg" />
              <div data-testid="transcript-empty" className={`tc ${txEmpty}`}>
                {empty}
              </div>
              <div className="tm" />
            </div>
          ) : (
            nest(visible.slice(0, at)).map((drawn) => drawRow(drawn, 0))
          )}
          {/* The foot closes the terminal, and holds the harness's working
              line while the view follows a live run at its head. */}
          <div className="tr tr-foot">
            <div className="tg" />
            <div className="tc">
              {live && following && at >= total ? <SkinFoot /> : null}
            </div>
            <div className="tm" />
          </div>
        </div>
      </div>
      {footer === null && pageFailure === null ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {footer === null ? null : (
            <span data-testid="transcript-count">{footer}</span>
          )}
          {drawnCursor === null ? null : (
            <button
              type="button"
              data-testid="transcript-more"
              disabled={reading || stream === "denied"}
              onClick={() => {
                void (searching ? moreMatches() : loadMore());
              }}
              className={txButton}
            >
              {reading ? t("readingMore") : t("more")}
            </button>
          )}
          {pageFailure === null ? null : (
            <span data-testid="transcript-page-failed" className="basis-full">
              {pageFailure.reason === "invalid"
                ? t("badCursor")
                : t("pageFailed")}
            </span>
          )}
        </div>
      )}
      <div className="mt-3">
        <Note testId="transcript-note">{t("note")}</Note>
      </div>
    </section>
  );
}

function FeedRowView({
  row,
  q,
  open,
  onToggle,
  place,
  run,
  live,
  answer,
  sealed,
  pause,
}: RowProps & {
  run: TranscriptRun;
  live: boolean;
  answer: boolean;
  sealed: boolean;
}) {
  switch (row.kind) {
    case "prompt":
      return (
        <PromptRow
          row={row}
          q={q}
          open={open}
          onToggle={onToggle}
          run={run}
          pause={pause}
        />
      );
    case "text":
      return (
        <TextRow
          row={row}
          q={q}
          open={open}
          onToggle={onToggle}
          answer={answer}
          pause={pause}
        />
      );
    case "calls":
      return <CallsRow row={row} pause={pause} />;
    case "thinking":
      return (
        <ThinkingRow
          row={row}
          q={q}
          open={open}
          onToggle={onToggle}
          pause={pause}
        />
      );
    case "tool":
      return (
        <ToolRow
          row={row}
          call={row.call}
          q={q}
          open={open}
          onToggle={onToggle}
          place={place}
          live={live}
          pause={pause}
        />
      );
    case "usage":
      return <UsageRow row={row} place={place} pause={pause} />;
    case "recall":
      return (
        <RecallRow
          row={row}
          q={q}
          open={open}
          onToggle={onToggle}
          place={place}
          pause={pause}
        />
      );
    case "seal":
      return (
        <SealRow
          row={row}
          q={q}
          place={place}
          sealedAt={sealed ? run.sealedAt : null}
          pause={pause}
        />
      );
    case "event":
      return (
        <EventRow
          row={row}
          q={q}
          open={open}
          onToggle={onToggle}
          place={place}
          pause={pause}
        />
      );
  }
}
