// The Transcript tab (mockup `pRun`'s transcript; spec §14): every run drawn
// the same way, from the run's start through each turn and its steps to each
// frame's body, with a transport that replays it.
//
// One read serves every zoom level: the transcript at `everything`, one entry
// per frame with the turn it falls in, so the view groups turns and steps
// itself and a change of level opens and closes disclosures rather than
// fetching again. Nothing here is stored, and nothing is inferred: a frame
// whose body was not retained says `digest_only` rather than showing an empty
// bubble, a body cut at the contract's ceiling links to the whole of it on
// the Frames tab, and a transcript that could not carry the whole run pages
// the rest in rather than stopping short of it.
//
// The chips are the filter, and they are links: a filter is a query value, so
// it survives a reload, opens in a new tab, and is in the URL a person copies.
// The chips that filter are the contract's own `TranscriptKind` list. The spec
// also draws `thinking` and `seal`, which `get_run_transcript` publishes no
// kind for, so those two sit in the row, in the spec's place, as counts that
// press nothing: thinking is counted from the reasoning blocks the recorder
// kept, and the seal names that no kind carries it. A chip that pretended to
// filter would promise a slice of the record that does not exist.
import { useLocale, useTranslations } from "next-intl";
import type {
  RunTranscript,
  TranscriptEntry,
  TranscriptKind,
} from "@/data/contracts/run";
import { TRANSCRIPT_KINDS } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { Panel } from "./parts";
import { isNonEmpty } from "./transcript-model";
import { TranscriptView } from "./transcript-view";
import { LiveEmptyFollow } from "./live-empty-follow";
import { isWhole } from "./whole-transcript";

type Place = { org: string; ws: string; runId: string };

/**
 * The chips as a URL value: `tools,errors`. The order follows the contract's
 * own list rather than the order they were pressed, so one filter has one URL
 * and two people who pressed the same chips share a link.
 */
export function kindsParam(
  kinds: readonly TranscriptKind[],
): string | undefined {
  const picked = TRANSCRIPT_KINDS.filter((kind) => kinds.includes(kind));
  return picked.length === 0 ? undefined : picked.join(",");
}

/**
 * The row of chips in the spec's order. A string is a kind the contract
 * filters on; `thinking` and `seal` are the two the spec draws that it does
 * not, and they render as counts rather than links. `errors` closes the row.
 * `policy` is the contract's own and sits after the spec's seven.
 */
const CHIP_ROW = [
  "prompt",
  "responses",
  "thinking",
  "tools",
  "usage",
  "recall",
  "seal",
  "policy",
  "errors",
] as const;
type ChipName = (typeof CHIP_ROW)[number];
type GapChip = Exclude<ChipName, TranscriptKind>;

/** Thinking and seal have no transcript kind to filter on, so their chips filter nothing. */
function isGapChip(name: ChipName): name is GapChip {
  return name === "thinking" || name === "seal";
}

/** True when an entry carries a reasoning block the recorder kept. */
function hasThinking(entry: TranscriptEntry): boolean {
  return [entry.request, entry.response].some(
    (half) => half?.blocks?.some((block) => block.kind === "thinking") ?? false,
  );
}

/**
 * Each chip's count, read from the whole-run transcript. Null when that read
 * failed: a chip with no count says nothing rather than zero. `seal` has no
 * count because no transcript kind carries it.
 */
export function chipCounts(
  read: Read<RunTranscript>,
): Partial<Record<ChipName, number>> | null {
  if (!read.ok) return null;
  const counts: Partial<Record<ChipName, number>> = {};
  for (const kind of TRANSCRIPT_KINDS)
    counts[kind] = read.value.entries.filter((entry) =>
      entry.kinds.includes(kind),
    ).length;
  counts.thinking = read.value.entries.filter(hasThinking).length;
  return counts;
}

/**
 * The filter chips. Each is a link that adds or removes its own kind. No chip
 * pressed keeps every entry, which is what the contract does with an empty
 * list, so the row's toggle reads "all" and appears once a chip narrows it.
 */
function KindChips({
  zoom,
  kinds,
  counts,
  org,
  ws,
  runId,
}: {
  zoom: RunTranscript["zoom"];
  kinds: readonly TranscriptKind[];
  /** Each chip's count over the whole run; null when that read failed. */
  counts: Partial<Record<ChipName, number>> | null;
} & Place) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const count = (name: ChipName) => {
    const value = counts?.[name];
    return value === undefined ? null : (
      <span
        data-testid={`chip-count-${name}`}
        className="font-mono text-[10.5px] tabular-nums text-dim"
      >
        {formatCount(value, locale)}
      </span>
    );
  };
  return (
    <nav
      aria-label={t("chipsLabel")}
      data-testid="transcript-chips"
      className="flex flex-wrap items-center gap-1 pb-3"
    >
      {CHIP_ROW.map((name) => {
        if (isGapChip(name))
          return (
            <span
              key={name}
              data-testid={`chip-${name}`}
              data-gap={`transcript-kind-${name}`}
              aria-disabled="true"
              title={t(`chipGap.${name}`)}
              className="inline-flex min-h-8 cursor-not-allowed items-center gap-1.5 rounded-full border border-dashed border-border px-3 text-xs text-muted-foreground"
            >
              {t(`chip.${name}`)}
              {count(name)}
              <span className="sr-only">{t(`chipGap.${name}`)}</span>
            </span>
          );
        const kind: TranscriptKind = name;
        const on = kinds.includes(kind);
        const next = on
          ? kinds.filter((held) => held !== kind)
          : [...kinds, kind];
        return (
          <SafeLink
            key={kind}
            to={routes.run(org, ws, runId, {
              tab: "transcript",
              zoom,
              kinds: kindsParam(next),
            })}
            data-testid={`chip-${kind}`}
            data-on={on ? "true" : "false"}
            // A chip is a link, so its state is `aria-current`, which a link
            // may carry, and not `aria-pressed`, which belongs to a button.
            aria-current={on ? "true" : undefined}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-border px-3 text-xs text-muted-foreground hover:text-foreground aria-[current=true]:border-foreground aria-[current=true]:text-foreground"
          >
            {t(`chip.${kind}`)}
            {count(kind)}
          </SafeLink>
        );
      })}
      {kinds.length === 0 ? null : (
        <SafeLink
          to={routes.run(org, ws, runId, { tab: "transcript", zoom })}
          data-testid="chip-clear"
          className="inline-flex min-h-8 items-center px-2 text-xs underline underline-offset-4"
        >
          {t("chipsClear")}
        </SafeLink>
      )}
    </nav>
  );
}

/**
 * The line above the feed: `<task> · <agent> · <model> · N turns · N steps ·
 * N entries · ● <status> · burn $ of $`. Each part the record lacks is left
 * out rather than printed as a zero; the burn is the running cost at the
 * run's last entry against the run's own total.
 */
function FeedHead({
  run,
  entries,
  complete,
}: {
  run: TranscriptRun;
  entries: readonly TranscriptEntry[];
  complete: boolean;
}) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const parts = [
    run.taskRef ?? null,
    run.agentKey ?? null,
    run.model?.slug ?? null,
    run.turns === null || run.turns === undefined
      ? null
      : t("head.turns", { count: run.turns }),
    run.steps === undefined ? null : t("head.steps", { count: run.steps }),
    t(complete ? "head.entries" : "head.entriesAtLeast", {
      count: entries.length,
      shown: formatCount(entries.length, locale),
    }),
  ].filter((part): part is string => part !== null);
  const burn = entries.at(-1)?.cumulativeCost ?? null;
  return (
    <p
      data-testid="transcript-head"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-2 font-mono text-[11.5px] text-muted-foreground"
    >
      <span>{parts.join(" · ")}</span>
      <span className="inline-flex items-center gap-1">
        <span
          aria-hidden="true"
          className={`size-1.5 rounded-full ${run.status === "live" ? "bg-success" : "bg-muted-foreground"}`}
        />
        {t(`head.status.${run.status}`)}
      </span>
      {burn === null ? null : (
        <span data-testid="transcript-burn">
          {t("head.burn")} <Money value={burn} />
          {run.cost === null || run.cost === undefined ? null : (
            <>
              {" "}
              {t("head.of")} <Money value={run.cost} />
            </>
          )}
        </span>
      )}
    </p>
  );
}

/** What the tab reads off the run row: the status always, the head line's parts when the page has them. */
type TranscriptRun = Pick<RunRow, "status" | "replayGrade"> &
  Partial<
    Pick<RunRow, "taskRef" | "agentKey" | "model" | "turns" | "steps" | "cost">
  >;

export function TranscriptSection({
  read,
  zoom,
  kinds,
  run,
  all,
  org,
  ws,
  runId,
}: {
  /** The transcript at `everything`: one entry per frame. */
  read: Read<RunTranscript>;
  /** The level the URL asked for: which disclosures start open. */
  zoom: RunTranscript["zoom"];
  /** The chips the URL pressed; empty keeps every entry. */
  kinds: readonly TranscriptKind[];
  run: TranscriptRun;
  /**
   * The whole-run transcript, unfiltered, which the chip counts and the head
   * line read. Defaults to `read`, which is the same read when no chip is
   * pressed.
   */
  all?: Read<RunTranscript>;
} & Place) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const place = { org, ws, runId };
  const whole = all ?? read;
  const chips = (
    <KindChips
      zoom={zoom}
      kinds={kinds}
      counts={chipCounts(whole)}
      {...place}
    />
  );
  if (!read.ok) {
    return (
      <Panel title={t("title")}>
        {chips}
        <ReadFailure read={read} section={t("title")} />
      </Panel>
    );
  }
  const { entries } = read.value;
  if (!isNonEmpty(entries)) {
    return (
      <Panel title={t("title")}>
        {chips}
        <p
          data-testid="transcript-empty"
          className="max-w-prose text-sm text-muted-foreground"
        >
          {kinds.length === 0
            ? t("empty")
            : t("emptyFiltered", { count: formatCount(kinds.length, locale) })}
        </p>
        {run.status === "live" ? (
          <LiveEmptyFollow org={org} ws={ws} runId={runId} />
        ) : null}
      </Panel>
    );
  }
  return (
    <div className="flex flex-col">
      {chips}
      <FeedHead
        run={run}
        entries={whole.ok ? whole.value.entries : entries}
        // A count past the page's end or the frame cap is a floor (`isWhole`).
        complete={whole.ok ? isWhole(whole.value) : isWhole(read.value)}
      />
      <TranscriptView
        // The view holds the pages it has appended, so a new filter must build
        // a new one rather than append a filtered page to an unfiltered one.
        key={kindsParam(kinds) ?? ""}
        transcript={read.value}
        entries={entries}
        kinds={kinds}
        zoom={zoom}
        status={run.status}
        replayGrade={run.replayGrade}
        org={org}
        ws={ws}
        runId={runId}
      />
      <p
        data-testid="run-transcript-note"
        className="mt-3 border-l-2 border-accent pl-3 text-xs text-muted-foreground"
      >
        {t("note")}
      </p>
    </div>
  );
}
