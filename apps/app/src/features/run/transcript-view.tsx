"use client";
// The Transcript tab's feed and its transport (mockup `transcriptTab`, `txRow`
// and the `.tx-*` rules in engine.css; pages/run.md, Transcript).
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
// match at once. A sealed run opens at its end; a live run opens following
// its head, and pausing stops following without touching the run.
//
// A live run follows its own head over the SSE route
// (`GET /v1/:org/:ws/runs/:run_id/stream`, reached same-origin through the
// `/api/v1/*` rewrite). The stream carries frames, and the transcript carries
// entries the contract derives from them, so a frame landing is the signal to
// read the tail rather than something to render. A run longer than one read
// is paged rather than truncated: entries are appended, never replaced, and a
// cursor this capability did not write is refused and said so.
import { useLocale, useTranslations } from "next-intl";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Cost, ratioOfMicros } from "@/data/contracts/money";
import {
  type RunTranscript,
  TRANSCRIPT_ENTRY_DEFAULT,
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
import type { ActionResult } from "@/server/kernel";
import { readTranscriptPage } from "./actions";
import { frameHref } from "./frame-link";
import type { KindFilter } from "./tab-props";
import { Note } from "./parts";
import type { ToolDiff, ToolGroup } from "./tool-detail";
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
  mergeEntries,
  rebaseEntries,
} from "./transcript-rows";
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

// ── The design's rules, as class recipes (ADR-132) ──────────────────────────

/**
 * `.txs { font-family:var(--mono); font-size:12.5px; line-height:1.65;
 * color:var(--fg) }`.
 */
const txs =
  "flex min-w-0 flex-col font-mono text-[12.5px] leading-[1.65] text-foreground";
/** `.tx-tools { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:0 0 10px }` */
const txTools = "flex flex-wrap items-center gap-2 pb-2.5";
/**
 * `.tx-tools input { background:var(--void); border:1px solid var(--border);
 * border-radius:8px; padding:6px 10px; font-size:12px; width:220px }`; a
 * phone gets the 16px input the house sheets use.
 */
const txSearch =
  "w-[220px] max-w-full max-md:w-full rounded-lg border border-border bg-void px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-dim focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring max-md:text-base";
/** `.tx-kinds { display:flex; flex-wrap:wrap; gap:3px }` */
const txKinds = "flex flex-wrap gap-[3px]";
/**
 * `.tx-kind { display:inline-flex; gap:6px; padding:3px 8px 3px 6px;
 * border-radius:6px; font-size:11px; color:var(--muted) }`, pressed
 * `{ background:var(--hl); color:var(--fg); box-shadow:inset 0 0 0 1px
 * var(--rule) }`, released `{ color:var(--dim) }` with its words struck.
 * `.all { padding-left:8px }`, and `.err[aria-pressed="true"] {
 * color:var(--st-failed) }`.
 */
const kindShape =
  "inline-flex items-center gap-1.5 rounded-md py-[3px] pr-2 font-mono text-[11px] focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-9";
const kindPressed =
  "aria-pressed:bg-hl aria-pressed:shadow-[inset_0_0_0_1px_var(--rule)] aria-[pressed=false]:text-dim aria-[pressed=false]:[&>span:not([data-dot])]:line-through";
const txKind = `${kindShape} ${kindPressed} pl-1.5 text-muted-foreground aria-pressed:text-foreground`;
const txKindAll = `${kindShape} pl-2 text-muted-foreground hover:text-foreground`;
const txKindErrors = `${kindShape} ${kindPressed} pl-1.5 text-muted-foreground aria-pressed:text-error`;
/** `.tx-kind .n { font-size:10px; color:var(--dim) }` */
const txKindCount = "text-[10px] tabular-nums text-dim";
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
/** `.tx-play { display:flex; gap:4px; margin-left:auto; flex-wrap:wrap }` */
const txPlay = "ml-auto flex flex-wrap items-center gap-1 max-md:ml-0";
/**
 * `.btn.sm` inside `.tx-play { padding:3px 8px; font-size:11.5px;
 * min-width:30px; justify-content:center }` over `.btn { border:1px solid
 * var(--border); background:var(--panel); border-radius:7px; font-weight:500;
 * gap:7px }`, `.btn:hover { border-color:var(--rule); background:var(--hl) }`
 * and `.tx-play .btn.sm[aria-pressed="true"]` the same; `.ghost` drops the
 * fill, and the play button is `min-width:74px`.
 */
const buttonShape =
  "inline-flex items-center justify-center gap-[7px] rounded-[7px] border border-border px-2 py-[3px] font-mono text-[11.5px] font-medium text-foreground transition-colors hover:border-rule hover:bg-hl aria-pressed:border-rule aria-pressed:bg-hl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 max-md:min-h-9";
const txButton = `${buttonShape} min-w-[30px] bg-card`;
const txGhost = `${buttonShape} min-w-[30px] bg-transparent`;
const txPlayButton = `${buttonShape} min-w-[74px] bg-card`;
/**
 * `.seg { display:inline-flex; gap:2px; padding:2px; border:1px solid
 * var(--border); border-radius:8px; background:var(--void) }` and `.seg .btn
 * { border-color:transparent; background:transparent }`, pressed `{
 * background:var(--hl); border-color:var(--rule) }`.
 */
const txSeg =
  "ml-1 inline-flex gap-0.5 rounded-lg border border-border bg-void p-0.5";
const txSegButton =
  "inline-flex min-w-[30px] items-center justify-center rounded-[7px] border border-transparent bg-transparent px-2 py-[3px] font-mono text-[11.5px] font-medium text-foreground hover:bg-hl aria-pressed:border-rule aria-pressed:bg-hl max-md:min-h-9";
/** `.tx-play .cnt { font-size:10.5px; color:var(--dim); margin-left:4px }` */
const txCount = "ml-1 whitespace-nowrap text-[10.5px] tabular-nums text-dim";
/**
 * `.tx-frame { background:var(--tx-surface); border:1px solid var(--border);
 * border-radius:12px; overflow:hidden }`.
 */
const txFrame =
  "overflow-hidden rounded-xl border border-border bg-(--tx-surface)";
/**
 * `.tx-runbar { display:flex; gap:12px; padding:9px 14px; border-bottom:1px
 * solid var(--border); background:var(--panel); flex-wrap:wrap }`,
 * `.name { font-weight:700; letter-spacing:.05em }`, `.meta { color:var(--dim);
 * font-size:11px }`.
 */
const txRunbar =
  "flex flex-wrap items-center gap-3 border-b border-border bg-card px-3.5 py-[9px]";
/**
 * `.tx-burn { display:flex; gap:8px; margin-left:auto; font-size:10.5px;
 * color:var(--muted) }`, `.bar { width:120px; height:4px; border-radius:2px;
 * background:var(--hl) }`, `.bar i { background:var(--st-approval) }`.
 */
const txBurn =
  "ml-auto flex items-center gap-2 whitespace-nowrap text-[10.5px] tabular-nums text-muted-foreground max-md:ml-0 max-md:flex-wrap max-md:whitespace-normal";
/** `.tx-feed { max-height:640px; overflow-y:auto; padding:6px 0 10px }` */
const txFeed =
  "max-h-[640px] overflow-y-auto pt-1.5 pb-2.5 motion-safe:scroll-smooth max-md:max-h-[70vh]";
/**
 * `.tx-row { display:grid; grid-template-columns:82px 30px minmax(0,1fr);
 * padding:1px 12px 1px 0 }`; a phone drops the clock (`0 22px`).
 */
/** A subagent's rows under the call that spawned it, on a rule of their own. */
const txNested = "mt-1 border-l border-border pl-2";
const txRow =
  "grid grid-cols-[82px_30px_minmax(0,1fr)] items-baseline py-px pr-3 max-md:grid-cols-[0_22px_minmax(0,1fr)]";
/** `.tx-clock { color:var(--dim); font-size:10.5px; text-align:right; padding-right:10px }` */
const txClock =
  "whitespace-nowrap pr-2.5 text-right text-[10.5px] tabular-nums text-dim max-md:invisible";
/**
 * `.tx-node { position:relative; align-self:stretch }` and its `::before`,
 * the 1px spine down the middle of the column.
 */
const txNode =
  "relative self-stretch text-center before:absolute before:inset-y-0 before:left-1/2 before:w-px before:bg-border";
/**
 * `.tx-dot { width:7px; height:7px; margin-top:6px; border-radius:50%;
 * background:var(--tx-surface); border:2px solid currentColor }`, and
 * `.solid { background:currentColor }` for a call that changed something.
 */
const txDot =
  "relative z-10 mt-1.5 inline-block size-[7px] rounded-full border-2 border-current bg-(--tx-surface)";
/** `.tx-role { grid-template-columns:72px minmax(0,1fr); padding:9px 0; border-bottom:1px solid var(--border) }` */
const txRole =
  "grid grid-cols-[72px_minmax(0,1fr)] border-b border-border py-[9px] max-md:grid-cols-1 max-md:gap-1";
/** `.tx-rolegut { text-align:right; padding-right:14px }` */
const txRoleGut = "pr-3.5 text-right max-md:p-0 max-md:text-left";
/**
 * `.tx-roletag { font-size:10px; font-weight:700; letter-spacing:.14em;
 * padding:1px 7px; border-radius:4px; color:var(--ink) }`, on `--tx-you`
 * (the muted ink) for YOU and `--tx-agent` (the ink) for the agent. The
 * words are sentence case in the catalogue, and the capitals are the style's.
 */
const txRoleTag =
  "rounded px-[7px] py-px text-[10px] font-bold uppercase tracking-[0.14em] text-background";
/**
 * `.tx-prose { max-width:72ch; white-space:pre-wrap; color:var(--body) }`,
 * open. Closed, the same column holds one line, cut with an ellipsis. The ink
 * is the row's, so the prompt and the answer can carry `--fg`.
 */
const txProse =
  "min-w-0 max-w-[72ch] whitespace-pre-wrap [overflow-wrap:anywhere]";
const txProseLine = "min-w-0 max-w-[72ch] truncate";
/** `.tx-answer { border-left:2px solid var(--tx-agent); padding-left:14px; color:var(--fg) }` */
const txAnswer = "border-l-2 border-foreground pl-3.5";
/** `.tx-sub { font-size:10.5px; color:var(--dim); margin-top:5px; gap:6px }` */
const txSub =
  "mt-[5px] flex flex-wrap items-baseline gap-1.5 text-[10.5px] text-dim";
/** `.tx-think { color:var(--dim); font-style:italic; max-width:72ch }`, open and closed. */
const txThink =
  "max-w-[72ch] whitespace-pre-wrap [overflow-wrap:anywhere] italic text-dim";
const txThinkLine = "min-w-0 max-w-[72ch] truncate italic text-dim";
/** `.tx-fold { border:0; background:none; font-size:10.5px; color:var(--dim) }` */
const txFold =
  "border-0 bg-transparent p-0 font-mono text-[10.5px] text-dim hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring";
/**
 * `.tx-call { display:flex; align-items:baseline; gap:8px; min-width:0 }`; on
 * a phone the chips wrap under the name rather than push the row sideways.
 */
const txCall = "flex min-w-0 items-baseline gap-2 max-md:flex-wrap";
/** `.tx-call .nm { font-weight:600; flex:none; min-width:8.5rem }` */
const txName = "flex-none font-semibold min-w-[8.5rem] max-md:min-w-0";
/** `.tx-call .arg { min-width:0; flex:1; text-overflow:ellipsis; color:var(--muted) }` */
const txArg = "min-w-0 flex-1 truncate text-muted-foreground";
/** `.tx-chips { margin-left:auto; display:flex; gap:5px; flex-wrap:wrap; flex:none }` */
const txChips =
  "ml-auto flex flex-none flex-wrap items-baseline gap-[5px] max-md:ml-0 max-md:flex-initial";
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
  "whitespace-nowrap rounded-[5px] border bg-card px-1.5 text-[10.5px] leading-[1.6] tabular-nums";
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
/**
 * `.tx-out { margin:2px 0 4px 20px; color:var(--muted); font-size:12px;
 * line-height:1.55 }` and `.tx-out.err { color:var(--st-failed) }`.
 */
const txOut =
  "mt-0.5 mb-1 ml-5 whitespace-pre-wrap [overflow-wrap:anywhere] text-xs leading-[1.55]";
/** `.tx-args { margin:2px 0 4px 20px; color:var(--dim); font-size:11px }` */
const txArgs =
  "mt-0.5 mb-1 ml-5 whitespace-pre-wrap [overflow-wrap:anywhere] text-[11px] text-dim";
/**
 * `.tx-diffwrap .path { font-size:11px; color:var(--muted); padding:4px 10px;
 * background:var(--panel); border:1px solid var(--border); border-bottom:0;
 * border-radius:9px 9px 0 0 }`.
 */
const txDiffPath =
  "flex items-center gap-2.5 rounded-t-[9px] border border-b-0 border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground";
/**
 * `.diff { background:var(--void); border:1px solid var(--border);
 * font-size:11.5px; line-height:1.6 }` with `.tx-diffwrap .diff {
 * border-radius:0 0 9px 9px; max-height:320px }`.
 */
const txDiff =
  "max-h-[320px] overflow-auto rounded-b-[9px] border border-border bg-void text-[11.5px] leading-[1.6]";
/**
 * `.dl { grid-template-columns:34px 34px minmax(0,1fr) }`, its numbers in the
 * dim ink right of a hairline, `.add`/`.del` washed 14% in the allowed and
 * denied hues.
 */
const txDiffLine = "grid grid-cols-[34px_34px_minmax(0,1fr)]";
const txDiffNum =
  "select-none border-r border-border px-1.5 text-right text-dim";
const DIFF_WASH: Record<DiffLine["op"], string> = {
  add: "bg-success/14 text-foreground",
  del: "bg-warning/14 text-foreground",
  ctx: "",
};
/** `.tx-usage { font-size:10.5px; color:var(--dim); gap:8px }` */
const txUsage = "flex min-w-0 items-baseline gap-2 text-[10.5px] text-dim";
/** `.tx-recall { grid-template-columns:auto minmax(0,1fr) auto; gap:2px 12px; font-size:11px; margin:3px 0 2px 20px }` */
const txRecall =
  "mt-[3px] mb-0.5 ml-5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 text-[11px]";
/** `.tx-empty { padding:18px 16px; color:var(--dim) }` */
const txEmpty = "px-4 py-[18px] text-dim";
/** `.txs mark { background:var(--gold); color:var(--on-gold); border-radius:2px }` */
const txMark = "rounded-[2px] bg-gold px-px text-on-gold";

/**
 * What a tool's family reads as, for the colour of its name (`--tx-inspect`
 * muted, `--tx-mutate` and `--tx-execute` the ink, `--tx-delegate` muted).
 * The design's `verify` and `repo` read a call's purpose, which the record
 * does not carry, so no call is coloured by them.
 */
const CALL_CLASS: Record<
  ToolGroup,
  "inspect" | "mutate" | "execute" | "delegate"
> = {
  shell: "execute",
  read: "inspect",
  search: "inspect",
  web: "inspect",
  edit: "mutate",
  create: "mutate",
  delete: "mutate",
  notebook: "mutate",
  skill: "delegate",
  agent: "delegate",
  plan: "delegate",
  mcp: "execute",
  tool: "execute",
};
const CALL_INK = {
  inspect: "text-muted-foreground",
  mutate: "text-foreground",
  execute: "text-foreground",
  delegate: "text-muted-foreground",
} as const;

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

/** The row's clock: the instant in the viewer's zone, with its place in the run as the title. */
function Clock({ at, elapsedMs }: { at: string; elapsedMs: number }) {
  const format = useFormatter();
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  return (
    <time
      dateTime={at}
      title={t("elapsed", { time: formatDuration(elapsedMs, locale) })}
      className={txClock}
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
 * (`⏵`/`⏶`); a call row ends its chips with it (`⋯`/`⏶`).
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
      className={`${txFold} ${className}`}
      aria-expanded={open}
      aria-label={label}
      onClick={onToggle}
    >
      {open ? "⏶" : closedGlyph}
    </button>
  );
}

/** `txDiffBlock`: the path, the stat, and every changed line, scrolled past 320px. */
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
    <div data-testid="tx-diff" className="mt-1 mb-1.5 ml-5 min-w-0">
      <div className={txDiffPath}>
        <b className="min-w-0 font-semibold text-foreground [overflow-wrap:anywhere]">
          {change.path}
        </b>
        {change.created ? <span>{t("newFile")}</span> : null}
        <span className="ml-auto">
          <b className="text-success">+{change.diff.added}</b>{" "}
          <b className="text-warning">−{change.diff.removed}</b>
        </span>
      </div>
      <div className={txDiff}>
        {shown.map((line) =>
          line.op === "gap" ? (
            <div key={line.key} className={txDiffLine}>
              <span className={txDiffNum} />
              <span className={txDiffNum} />
              <span className="px-2.5 text-center text-dim">⋯</span>
            </div>
          ) : (
            <div
              key={`${line.op}-${String(line.before ?? "n")}-${String(line.after ?? "n")}`}
              className={`${txDiffLine} ${DIFF_WASH[line.op]}`}
            >
              <span className={txDiffNum}>{line.before ?? ""}</span>
              <span className={txDiffNum}>{line.after ?? ""}</span>
              <span className="whitespace-pre-wrap px-2.5 [overflow-wrap:anywhere]">
                {line.op === "add" ? "+" : line.op === "del" ? "−" : " "}{" "}
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
};

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
  className,
}: {
  text: string;
  q: string;
  open: boolean;
  onToggle: () => void;
  className: string;
}) {
  const t = useTranslations("run.transcript");
  return (
    <div className={`${open ? txProse : txProseLine} ${className}`}>
      <Fold
        open={open}
        label={open ? t("showLess") : t("showFull")}
        closedGlyph="⏵"
        onToggle={onToggle}
        className="pr-1.5"
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

function PromptRow({
  row,
  q,
  open,
  onToggle,
  run,
}: Omit<RowProps, "row" | "place"> & {
  row: Extract<FeedRow, { kind: "prompt" }>;
  run: TranscriptRun;
}) {
  const t = useTranslations("run.transcript");
  return (
    <div data-testid="transcript-you" className={txRole}>
      <div className={txRoleGut}>
        <span className={`${txRoleTag} bg-muted-foreground`}>{t("you")}</span>
      </div>
      <div className="min-w-0">
        <Prose
          text={row.text}
          q={q}
          open={open}
          onToggle={() => {
            onToggle(row.key);
          }}
          className="text-foreground"
        />
        {open ? (
          <div className={txSub}>
            {run.operatorName === null ? null : (
              <span>{t("operator", { name: run.operatorName })}</span>
            )}
            {row.first && run.taskRef !== null ? (
              <span>{t("task", { ref: run.taskRef })}</span>
            ) : null}
            <span>
              {row.first
                ? t("firstPrompt")
                : row.turn === null
                  ? t("laterPrompt")
                  : t("turn", { n: row.turn })}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TextRow({
  row,
  q,
  open,
  onToggle,
  answer,
}: Omit<RowProps, "row" | "place"> & {
  row: Extract<FeedRow, { kind: "text" }>;
  answer: boolean;
}) {
  const t = useTranslations("run.transcript");
  return (
    <div data-testid="transcript-agent" className={txRole}>
      <div className={txRoleGut}>
        <span className={`${txRoleTag} bg-foreground`}>
          {answer ? t("answer") : t("agent")}
        </span>
      </div>
      <div className="flex min-w-0 items-baseline gap-2">
        <Prose
          text={row.text}
          q={q}
          open={open}
          onToggle={() => {
            onToggle(row.key);
          }}
          className={
            answer ? `${txAnswer} text-foreground` : "text-(color:--body)"
          }
        />
        <SubagentChip row={row} />
      </div>
    </div>
  );
}

/**
 * A model step whose kept reply said nothing in words: what it called, on
 * one dim line under the agent's tag. It is the step's row under the
 * responses chip, so that chip shows every step it counts.
 */
function CallsRow({ row }: { row: Extract<FeedRow, { kind: "calls" }> }) {
  const t = useTranslations("run.transcript");
  const line =
    row.tools.length === 0
      ? t("saidNothing")
      : t("calledTools", { tools: row.tools.join(", ") });
  return (
    <div data-testid="transcript-calls" className={txRole}>
      <div className={txRoleGut}>
        <span className={`${txRoleTag} bg-foreground`}>{t("agent")}</span>
      </div>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate italic text-dim" title={line}>
          {line}
        </span>
        <SubagentChip row={row} />
      </div>
    </div>
  );
}

function ThinkingRow({
  row,
  q,
  open,
  onToggle,
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
      <div
        data-testid="step-thinking-unkept"
        className="min-w-0 truncate italic text-dim"
        title={unkept}
      >
        {unkept}
      </div>
    );
  }
  const lines = row.text.split("\n").length;
  const toggle = () => {
    onToggle(row.key);
  };
  return (
    <div>
      <div className="flex min-w-0 items-baseline gap-2">
        <button
          type="button"
          className={`${txFold} flex-none`}
          aria-expanded={open}
          onClick={toggle}
        >
          <span aria-hidden="true">{open ? "⏶ " : "⏵ "}</span>
          {t("thinkingLines", { count: lines })}
        </button>
        {open ? null : (
          <span
            data-testid="tx-think"
            className={`${txThinkLine} cursor-pointer`}
            onClick={lineClick(toggle)}
          >
            <Hi text={closedLine(row.text)} q={q} />
          </span>
        )}
      </div>
      {open ? (
        <div data-testid="tx-think" className={txThink}>
          <Hi text={row.text} q={q} />
        </div>
      ) : null}
    </div>
  );
}

function ToolRow({
  row,
  call,
  q,
  open,
  onToggle,
  place,
  live,
}: RowProps & { call: FeedCall; live: boolean }) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const failed = row.failed;
  const kind = CALL_CLASS[call.group];
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
    <div>
      <div className={txCall}>
        <span
          aria-hidden="true"
          className={`flex-none select-none ${failed ? "text-error" : "text-dim"}`}
        >
          {failed ? "✗" : "●"}
        </span>
        <span
          data-testid="tx-call-line"
          className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2"
          onClick={lineClick(toggle)}
        >
          <span
            data-testid="tx-tool-name"
            className={`${txName} ${failed ? "text-error" : CALL_INK[kind]}`}
          >
            <Hi text={call.name} q={q} />
          </span>
          {call.arg === null ? null : (
            <span data-testid="tx-tool-arg" className={txArg} title={call.arg}>
              <Hi text={call.arg} q={q} />
            </span>
          )}
        </span>
        <span className={txChips}>
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
        </span>
      </div>
      {open ? (
        <div data-testid="tx-call-fold">
          {call.raw === null ? null : (
            <pre data-testid="tx-args" className={txArgs}>
              <Hi text={call.raw} q={q} />
            </pre>
          )}
          {call.diffs.map((change, index) => (
            <DiffBlock
              key={`${change.path}-${String(index)}`}
              change={change}
              q={q}
            />
          ))}
          {output === null ? null : (
            <pre
              data-testid="tx-out"
              className={`${txOut} ${failed ? "text-error" : "text-muted-foreground"}`}
            >
              <Hi text={output} q={q} />
            </pre>
          )}
          {call.parked === null ? null : (
            <div className={`${txSub} ml-5`}>
              {t("parkedNote")}
              {call.approvalId === null ? null : (
                <span data-testid="tx-parked-approval">
                  {t.rich("parkedApproval", {
                    approval: call.approvalId,
                    // The raw id is a detail to copy, so one click selects the
                    // whole of it.
                    code: (chunks) => (
                      <span className="select-all text-muted-foreground">
                        {chunks}
                      </span>
                    ),
                  })}
                </span>
              )}
            </div>
          )}
          <div className={`${txSub} ml-5`}>
            <FrameChip frame={call.frame} place={place}>
              {t("frame", { type: call.frame.type, seq: call.frame.seq })}
            </FrameChip>
            {call.truncated ? <span>{t("truncated")}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
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
}: {
  row: Extract<FeedRow, { kind: "usage" }>;
  place: Place;
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
  return (
    <div data-testid="tx-usage" className={txUsage}>
      <span className="min-w-0 truncate">
        {[t("usage"), row.model, ...counts]
          .filter((part): part is string => part !== null)
          .join(" · ")}
      </span>
      <span className={txChips}>
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
      </span>
    </div>
  );
}

function RecallRow({
  row,
  q,
  open,
  onToggle,
  place,
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
  // `color:var(--st-proven); font-weight:600; font-size:12.5px` on the heading.
  // Closed, the heading is the whole row; what reached the model opens under
  // it. The server states each item's outcome; the cuts are counted in the
  // heading and listed on the Context tab.
  const reached = recall.items.filter((item) => item.outcome === "included");
  const foldable = reached.length > 0;
  const toggle = () => {
    onToggle(row.key);
  };
  return (
    <div data-testid="tx-recall">
      <div className={txCall}>
        <span
          data-testid="tx-recall-heading"
          className={`min-w-0 flex-1 truncate text-[12.5px] font-semibold text-proven ${foldable ? "cursor-pointer" : ""}`}
          onClick={foldable ? lineClick(toggle) : undefined}
        >
          <span aria-hidden="true">◉ </span>
          {heading}
        </span>
        <span className={txChips}>
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
        </span>
      </div>
      {open && foldable ? (
        <div data-testid="tx-recall-items" className={txRecall}>
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
      ) : null}
    </div>
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
      <span className="text-dim">{item.kind}</span>
      <span className="truncate text-(color:--body)">
        <Hi text={item.label} q={q} />
      </span>
      <span className="text-right tabular-nums text-dim">
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
}: {
  row: Extract<FeedRow, { kind: "seal" }>;
  q: string;
  place: Place;
  /** The run's seal, when this is its last stop frame and the run is sealed. */
  sealedAt: string | null;
}) {
  const t = useTranslations("run.transcript");
  const format = useFormatter();
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="flex-none font-semibold text-success">
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
        <span className="min-w-0 truncate text-dim" title={row.label}>
          <Hi text={closedLine(row.label)} q={q} />
        </span>
      )}
      <span className={txChips}>
        <FrameChip frame={row.frame} place={place}>
          {t("frame", { type: row.frame.type, seq: row.frame.seq })}
        </FrameChip>
      </span>
    </div>
  );
}

function EventRow({
  row,
  q,
  open,
  onToggle,
  place,
}: Omit<RowProps, "row"> & { row: Extract<FeedRow, { kind: "event" }> }) {
  const t = useTranslations("run.transcript");
  const line = row.text === null ? "" : closedLine(row.text);
  const foldable = line !== "";
  const toggle = () => {
    onToggle(row.key);
  };
  return (
    <div>
      <div className={txCall}>
        <span
          aria-hidden="true"
          className={`flex-none select-none ${row.failed ? "text-error" : "text-dim"}`}
        >
          {row.failed ? "✗" : "●"}
        </span>
        <span
          className={`flex min-w-0 flex-1 items-baseline gap-2 ${foldable ? "cursor-pointer" : ""}`}
          onClick={foldable ? lineClick(toggle) : undefined}
        >
          <span
            className={`${txName} ${row.failed ? "text-error" : "text-muted-foreground"}`}
          >
            <Hi text={row.name} q={q} />
          </span>
          {foldable ? (
            <span data-testid="tx-event-line" className={txArg} title={line}>
              <Hi text={line} q={q} />
            </span>
          ) : null}
        </span>
        <span className={txChips}>
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
        </span>
      </div>
      {open && foldable && row.text !== null ? (
        <pre
          data-testid="tx-event-text"
          className={`${txOut} ${row.failed ? "text-error" : "text-muted-foreground"}`}
        >
          <Hi text={row.text} q={q} />
        </pre>
      ) : null}
    </div>
  );
}

/** The dot on the spine: a tool call's family, coloured by what it did. */
function NodeDot({ row }: { row: FeedRow }) {
  if (row.kind !== "tool") return null;
  const kind = CALL_CLASS[row.call.group];
  return (
    <span
      aria-hidden="true"
      className={`${txDot} ${kind === "mutate" ? "bg-current" : ""} ${row.failed ? "text-error" : CALL_INK[kind]}`}
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
      <span className="h-1 w-[120px] overflow-hidden rounded-[2px] bg-hl">
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
  run,
  kinds,
  org,
  ws,
  runId,
}: {
  /**
   * `cursor` is set when entries lie past this read: more can be paged in.
   * `counts` is the whole run's, counted by the server. `frameCursor` is
   * where the live stream opens.
   */
  transcript: Pick<
    RunTranscript,
    "complete" | "cursor" | "counts" | "frameCursor"
  >;
  /** The whole-run transcript's entries at `steps`, at least one. */
  entries: Frames;
  run: TranscriptRun;
  /** The URL's `?kinds=`, which sets the chips a link opens with. */
  kinds: KindFilter;
} & Place) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const navigate = useNavigate();
  const place = useMemo(() => ({ org, ws, runId }), [org, ws, runId]);
  const live = run.status === "live";
  // The whole run's counts, from the read that began at the run's first
  // frame. A later page reads a window of the run and carries none, so each
  // chip keeps its whole-run count until the page reads the run again
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

  // The page read the run again: the seal refreshes it, and so do the run
  // controls. That read is the record as it stands, in the order the server
  // placed it, so it replaces what this view had paged in, and its counts
  // replace the chips'. A subagent frame that landed before the cursor
  // reaches the tail read too (#4083), and this read places it the same way.
  // Entries this view read past the page's own bound stay, and so does the
  // cursor that reached them.
  const [readFrom, setReadFrom] = useState(first);
  if (readFrom !== first) {
    setReadFrom(first);
    const rebased = rebaseEntries(first, entries);
    setEntries(rebased);
    setCounts(transcript.counts);
    if (rebased.length === first.length) {
      setCursor(transcript.cursor);
      setComplete(transcript.complete);
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
  // a live run's new rows appear as they land.
  const [pos, setPos] = useState<number | null>(null);
  const [playing, setPlaying] = useState(live);
  const [speed, setSpeed] = useState<Speed>(1);
  const at = paced ? Math.min(pos ?? total, total) : total;
  // A sealed run stops at its last row; a live one waits there for more.
  const isPlaying = playing && paced && (live || at < total);
  const done = !isPlaying && at >= total && !live;
  const feedRef = useRef<HTMLDivElement>(null);

  /**
   * Read the page past the cursor and append it. Nothing already on screen is
   * replaced, so the scroll position and the playhead survive the read.
   *
   * A coalesced stream signal is only "there is more to read", not a page
   * count. When a page comes back full (entry count equals the request
   * limit) and still carries a resume cursor, this drains the next page in
   * the same call so a long live replay does not stall hundreds of entries
   * behind the head until another frame lands.
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
        // whole, at the zoom and text the page read.
        const read = await readTranscriptPage(org, ws, runId, "steps", {
          after: cursorRef.current,
          text: "full",
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
        // subagent's entry that landed before the cursor goes under its call.
        const next: Frames = mergeEntries(heldRef.current, pageEntries);
        heldRef.current = next;
        setEntries(next);
        // Full page with a resume cursor means more history is waiting.
        // Drain it now. A short page or a null cursor ends the drain.
        drainMore =
          pageEntries.length === TRANSCRIPT_ENTRY_DEFAULT &&
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
  }, [org, runId, ws]);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

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

  // Playback reveals the next row after the recorded gap to it.
  useEffect(() => {
    if (!isPlaying || at >= total) return;
    const next = visible[at];
    const previous = at === 0 ? 0 : (visible[at - 1]?.elapsedMs ?? 0);
    const gap = (next?.elapsedMs ?? previous) - previous;
    const timer = setTimeout(
      () => {
        setPos(at + 1 >= total ? null : at + 1);
      },
      paceMs(gap, speed),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [isPlaying, at, total, visible, speed]);

  // Keep the newest row in view while playing or following.
  useEffect(() => {
    if (!isPlaying) return;
    const feed = feedRef.current;
    if (feed !== null) feed.scrollTop = feed.scrollHeight;
  }, [isPlaying, at]);

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
    setPos(clamped >= total && live && isPlaying ? null : clamped);
  };
  const step = (by: number) => {
    setPlaying(false);
    setPos(Math.max(0, Math.min(total, at + by)));
  };
  const playPause = () => {
    if (done) {
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

  const footer =
    stream === "denied"
      ? t("followDenied")
      : stream === "lost"
        ? t("followLost")
        : stream === "sealed"
          ? t("followSealed")
          : live && stream !== "off" && !searching
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

  // One drawn row, with the subagent rows under it drawn inside it.
  const drawRow = ({ row, index, children }: Drawn): ReactNode => (
    <div
      key={row.key}
      data-testid="tx-row"
      data-kind={row.kind}
      className={txRow}
    >
      <Clock at={row.at} elapsedMs={row.elapsedMs} />
      <span className={txNode}>
        <NodeDot row={row} />
      </span>
      <div className="min-w-0">
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
        />
        {children.length === 0 ? null : (
          <div data-testid="transcript-subagent-steps" className={txNested}>
            {children.map(drawRow)}
          </div>
        )}
      </div>
    </div>
  );

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
            className="font-mono text-[10.5px] text-dim"
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
            className="font-mono text-[10.5px] text-dim"
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
        <div role="group" aria-label={t("transportLabel")} className={txPlay}>
          <button
            type="button"
            data-testid="expand-thinking"
            aria-pressed={thinking}
            className={txGhost}
            onClick={() => {
              setThinking((prev) => !prev);
              setOpen(new Set());
            }}
          >
            {thinking ? t("collapseThinking") : t("expandThinking")}
          </button>
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
        </div>
      </div>
      <div className={txFrame}>
        <div data-testid="tx-runbar" className={txRunbar}>
          <span className="font-bold tracking-[0.05em]">
            {run.taskRef ?? runId}
          </span>
          <span className="text-[11px] text-dim">{meta.join(" · ")}</span>
          <span className="flex flex-wrap gap-[5px]">
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
          </span>
          <Burn spent={spent} total={spentTotal} />
        </div>
        <div ref={feedRef} data-testid="tx-feed" className={txFeed}>
          {total === 0 ? (
            <div data-testid="transcript-empty" className={txEmpty}>
              {empty}
            </div>
          ) : (
            nest(visible.slice(0, at)).map(drawRow)
          )}
        </div>
        {footer === null && pageFailure === null ? null : (
          <div className="flex flex-wrap items-center gap-2 border-t border-border bg-card px-3.5 py-2 text-[11px] text-muted-foreground">
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
      </div>
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
}: RowProps & {
  run: TranscriptRun;
  live: boolean;
  answer: boolean;
  sealed: boolean;
}) {
  switch (row.kind) {
    case "prompt":
      return (
        <PromptRow row={row} q={q} open={open} onToggle={onToggle} run={run} />
      );
    case "text":
      return (
        <TextRow
          row={row}
          q={q}
          open={open}
          onToggle={onToggle}
          answer={answer}
        />
      );
    case "calls":
      return <CallsRow row={row} />;
    case "thinking":
      return <ThinkingRow row={row} q={q} open={open} onToggle={onToggle} />;
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
        />
      );
    case "usage":
      return <UsageRow row={row} place={place} />;
    case "recall":
      return (
        <RecallRow
          row={row}
          q={q}
          open={open}
          onToggle={onToggle}
          place={place}
        />
      );
    case "seal":
      return (
        <SealRow
          row={row}
          q={q}
          place={place}
          sealedAt={sealed ? run.sealedAt : null}
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
        />
      );
  }
}
