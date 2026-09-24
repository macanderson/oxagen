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
// the Governed actions tab, and a transcript that could not carry the whole run pages
// the rest in rather than stopping short of it.
//
// The chips are the filter, and they are links: a filter is a query value, so
// it survives a reload, opens in a new tab, and is in the URL a person copies.
// They are the mockup's chips in the mockup's order (`mockups/pages/run.md`,
// Transcript): prompt, responses, thinking, tools, usage, recall and seal,
// each with its count, then an all/none toggle and errors. An earlier
// revision drew the contract's kinds instead, because the contract published
// no thinking or seal kind and a chip that filtered on nothing would promise a
// slice of the record that does not exist. The contract now publishes both,
// so the page draws the mockup of record. `policy` has no chip of its own:
// a tool call's gate decision rides the tools chip, and the Policy tab reads
// the kind directly.
//
// A chip that is on shows its kind. Every chip on is no filter at all, the
// contract's empty list; every chip off is `kinds=none`, which reads nothing.
//
// Above the feed sits the spec's head line (task, agent, model, turns, steps,
// entries, status and burn), and under it the note that the transcript is
// what the agent showed its operator.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
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
 * What the chips select: a list of the contract's kinds, where empty keeps
 * every entry, or `none`, which keeps nothing and reads nothing.
 */
export type KindFilter = readonly TranscriptKind[] | "none";

/** The mockup's chips, each over the contract kinds it shows. */
const CHIPS = [
  { chip: "prompt", kinds: ["prompt"] },
  { chip: "responses", kinds: ["responses"] },
  { chip: "thinking", kinds: ["thinking"] },
  { chip: "tools", kinds: ["tools", "policy"] },
  { chip: "usage", kinds: ["usage"] },
  { chip: "recall", kinds: ["recall"] },
  { chip: "seal", kinds: ["seal"] },
] as const satisfies readonly {
  chip: TranscriptKind;
  kinds: readonly TranscriptKind[];
}[];

type Chip = (typeof CHIPS)[number]["chip"];

/** Whether the filter is the errors toggle alone. */
function errorsOnly(kinds: KindFilter): boolean {
  return kinds !== "none" && kinds.length === 1 && kinds[0] === "errors";
}

/** The chips a filter shows as on. No filter is every chip on. */
function chipsOn(kinds: KindFilter): ReadonlySet<Chip> {
  if (kinds === "none" || errorsOnly(kinds)) return new Set();
  if (kinds.length === 0) return new Set(CHIPS.map(({ chip }) => chip));
  return new Set(
    CHIPS.filter(({ chip }) => kinds.includes(chip)).map(({ chip }) => chip),
  );
}

/** The filter a set of chips selects: every chip is no filter, no chip is `none`. */
function filterOf(on: ReadonlySet<Chip>): KindFilter {
  if (on.size === CHIPS.length) return [];
  if (on.size === 0) return "none";
  return CHIPS.filter(({ chip }) => on.has(chip)).flatMap(({ kinds }) => kinds);
}

/**
 * The filter as a URL value: `tools,errors`, or `none`. The order follows the
 * contract's own list rather than the order the chips were pressed, so one
 * filter has one URL and two people who chose the same chips share a link.
 */
export function kindsParam(kinds: KindFilter): string | undefined {
  if (kinds === "none") return "none";
  const picked = TRANSCRIPT_KINDS.filter((kind) => kinds.includes(kind));
  return picked.length === 0 ? undefined : picked.join(",");
}

/**
 * `?kinds=` as a filter. `none` is the all/none toggle turned off; an unknown
 * word is dropped, not refused.
 */
export function parseKinds(raw: string | null): KindFilter {
  if (raw === null) return [];
  if (raw === "none") return "none";
  const asked = new Set(raw.split(","));
  return TRANSCRIPT_KINDS.filter((kind) => asked.has(kind));
}

/**
 * How many entries of the whole-run read answer to each chip, and to errors.
 * A read that stopped short gives a floor, and says so with a plus. A failed
 * read gives no counts rather than zeros.
 */
function useChipCounts(
  tally: Read<RunTranscript> | undefined,
): ((kinds: readonly TranscriptKind[]) => string) | null {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  if (tally === undefined || !tally.ok) return null;
  const { entries } = tally.value;
  const floor = !isWhole(tally.value);
  return (kinds) => {
    const count = formatCount(
      entries.filter((entry) =>
        entry.kinds.some((kind) => kinds.includes(kind)),
      ).length,
      locale,
    );
    return floor ? t("chipCountFloor", { count }) : t("chipCount", { count });
  };
}

const chipClass =
  "inline-flex min-h-11 sm:min-h-8 items-center gap-1.5 rounded-full border border-border px-3 text-xs text-muted-foreground hover:text-foreground aria-[current=true]:border-foreground aria-[current=true]:text-foreground";

/**
 * The filter chips. Each is a link that turns its own kind on or off, then
 * the all/none toggle and errors, which shows only failed calls.
 */
function KindChips({
  zoom,
  kinds,
  tally,
  org,
  ws,
  runId,
}: {
  zoom: RunTranscript["zoom"];
  kinds: KindFilter;
  /** The whole-run read the counts come from; absent draws no counts. */
  tally?: Read<RunTranscript>;
} & Place) {
  const t = useTranslations("run.transcript");
  const count = useChipCounts(tally);
  const on = chipsOn(kinds);
  const errors = errorsOnly(kinds);
  const anyOff = on.size < CHIPS.length;
  const link = (next: KindFilter) =>
    routes.run(org, ws, runId, {
      tab: "transcript",
      zoom,
      kinds: kindsParam(next),
    });
  return (
    <nav
      aria-label={t("chipsLabel")}
      data-testid="transcript-chips"
      className="flex flex-wrap items-center gap-1"
    >
      {CHIPS.map(({ chip, kinds: shows }) => {
        const pressed = on.has(chip);
        const next = new Set(on);
        if (pressed) next.delete(chip);
        else next.add(chip);
        return (
          <SafeLink
            key={chip}
            to={link(filterOf(next))}
            data-testid={`chip-${chip}`}
            data-on={pressed ? "true" : "false"}
            // A chip is a link, so its state is `aria-current`, which a link
            // may carry, and not `aria-pressed`, which belongs to a button.
            aria-current={pressed ? "true" : undefined}
            className={chipClass}
          >
            {t(`chip.${chip}`)}
            {count === null ? null : (
              <span
                data-testid={`chip-${chip}-count`}
                className="font-mono text-[10.5px] tabular-nums"
              >
                {count(shows)}
              </span>
            )}
          </SafeLink>
        );
      })}
      <SafeLink
        to={link(anyOff ? [] : "none")}
        data-testid="chip-all"
        className="inline-flex min-h-11 items-center px-2 text-xs underline underline-offset-4 sm:min-h-8"
      >
        {anyOff ? t("chipsAll") : t("chipsNone")}
      </SafeLink>
      <SafeLink
        to={link(errors ? [] : ["errors"])}
        data-testid="chip-errors"
        data-on={errors ? "true" : "false"}
        aria-current={errors ? "true" : undefined}
        title={t("errorsTitle")}
        className={`${chipClass} aria-[current=true]:border-destructive aria-[current=true]:text-destructive`}
      >
        <span aria-hidden="true">✗</span>
        {t("chip.errors")}
        {count === null ? null : (
          <span
            data-testid="chip-errors-count"
            className="font-mono text-[10.5px] tabular-nums"
          >
            {count(["errors"])}
          </span>
        )}
      </SafeLink>
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
  tally,
  zoom,
  kinds,
  run,
  org,
  ws,
  runId,
}: {
  /** The transcript at `everything`: one entry per frame. */
  read: Read<RunTranscript>;
  /** The whole-run read the chip counts come from; absent draws no counts. */
  tally?: Read<RunTranscript>;
  /** The level the URL asked for: which disclosures start open. */
  zoom: RunTranscript["zoom"];
  /** What the chips select; an empty list keeps every entry, `none` keeps none. */
  kinds: KindFilter;
  run: TranscriptRun;
} & Place) {
  const t = useTranslations("run.transcript");
  const place = { org, ws, runId };
  const chips: ReactNode = (
    <KindChips zoom={zoom} kinds={kinds} tally={tally} {...place} />
  );
  if (kinds === "none") {
    return (
      <Panel title={t("title")}>
        {chips}
        <p
          data-testid="transcript-empty"
          className="max-w-prose text-sm text-muted-foreground"
        >
          {t("emptyFiltered")}
        </p>
      </Panel>
    );
  }
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
          {kinds.length === 0 ? t("empty") : t("emptyFiltered")}
        </p>
        {run.status === "live" ? (
          <LiveEmptyFollow org={org} ws={ws} runId={runId} />
        ) : null}
      </Panel>
    );
  }
  // The head line counts the whole run where that read is in hand, and the
  // page it has otherwise. A count past a page's end or the frame cap is a
  // floor (`isWhole`).
  const whole = tally?.ok === true ? tally.value : read.value;
  return (
    <div className="flex flex-col">
      <FeedHead run={run} entries={whole.entries} complete={isWhole(whole)} />
      <TranscriptView
        // The view holds the pages it has appended, so a new filter must build
        // a new one rather than append a filtered page to an unfiltered one.
        key={kindsParam(kinds) ?? ""}
        transcript={read.value}
        entries={entries}
        kinds={kinds}
        chips={chips}
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
