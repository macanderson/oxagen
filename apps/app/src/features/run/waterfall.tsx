// The run waterfall (spec §12.9): the run's turns as bars, the steps inside
// them, and the cost accumulating left to right.
//
// It is drawn from the run's own per-turn ledger, which is the transcript read
// twice: once at the `turns` zoom for the bars, once at `steps` for the
// segments inside them. A step belongs to the turn whose sequence range holds
// its opening frame, so the two reads are joined on the record's own numbers
// and nothing is inferred from their order.
//
// Each bar starts where the previous turn's total ended and is as wide as that
// turn's own cost, both as a share of the run total. The running total beside
// it is the contract's `cumulativeCost`, a prefix sum over the whole run, so
// the last row is the run total and the header is a rollup of the rows rather
// than a figure typed twice.
//
// A turn whose cost the recording did not carry draws no bar. A zero-width bar
// would read as "this turn cost nothing", which is a measurement nobody made.
import { useLocale, useTranslations } from "next-intl";
import type { RunTranscript, TranscriptEntry } from "@/data/contracts/run";
import { ratioOfIntegers } from "@/data/contracts/money";
import type { Read } from "@/data/read";
import { mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { ReadFailure } from "@/ui/read-failure";
import { formatElapsed } from "./entry";
import { NoValue } from "./parts";

/** A turn, the steps recorded inside its sequence range, and where its bar sits. */
type Bar = {
  turn: TranscriptEntry;
  steps: TranscriptEntry[];
  /** Share of the run total the turns before this one account for, 0…1. */
  offset: number;
  /** Share of the run total this turn accounts for, 0…1; null when its cost was not recorded. */
  width: number | null;
};

/**
 * Join the two reads on the sequence ranges the contract recorded, and place
 * each turn against the run total.
 *
 * The total is the last turn's cumulative cost, which is the contract's own
 * prefix sum. Taking it from anywhere else would let the bars and the running
 * totals disagree about the same run.
 */
export function buildBars(
  turns: readonly TranscriptEntry[],
  steps: readonly TranscriptEntry[],
): { bars: Bar[]; total: TranscriptEntry["cumulativeCost"] } {
  const last = turns.at(-1);
  const total = last === undefined ? null : last.cumulativeCost;
  const inRange = (step: TranscriptEntry, turn: TranscriptEntry): boolean =>
    BigInt(step.seq) >= BigInt(turn.seq) &&
    BigInt(step.seq) <= BigInt(turn.endSeq);
  const bars = turns.map((turn) => {
    const before = turn.cumulativeCost;
    const width =
      total === null ||
      turn.cost === null ||
      turn.cost.currency !== total.currency
        ? null
        : ratioOfIntegers(turn.cost.micros, total.micros);
    // The turn's own cost is inside its cumulative total, so the offset is the
    // total up to and including it, less its own share.
    const through =
      total === null || before === null || before.currency !== total.currency
        ? 0
        : ratioOfIntegers(before.micros, total.micros);
    return {
      turn,
      steps: steps.filter((step) => inRange(step, turn)),
      offset: Math.max(through - (width ?? 0), 0),
      width,
    };
  });
  return { bars, total };
}

function StepSegments({ bar }: { bar: Bar }) {
  const t = useTranslations("run.waterfall");
  if (bar.steps.length === 0) return null;
  // Inside one turn the steps are split by their share of the turn's own cost,
  // so a segment says how much of this turn that step was.
  const priced = bar.steps.filter(
    (step) =>
      step.cost !== null &&
      bar.turn.cost !== null &&
      step.cost.currency === bar.turn.cost.currency,
  );
  if (priced.length === 0 || bar.turn.cost === null) return null;
  return (
    <span className="absolute inset-0 flex" aria-hidden="true">
      {priced.map((step) => (
        <span
          key={`${step.seq}-${step.endSeq}`}
          data-testid="waterfall-step"
          title={t("step", { label: step.label })}
          style={{
            width: `${ratioOfIntegers(step.cost!.micros, bar.turn.cost!.micros) * 100}%`,
          }}
          className="border-r border-background/60 last:border-r-0"
        />
      ))}
    </span>
  );
}

export function Waterfall({
  turns,
  steps,
}: {
  turns: Read<RunTranscript>;
  steps: Read<RunTranscript>;
}) {
  const t = useTranslations("run.waterfall");
  const locale = useLocale();
  if (!turns.ok) return <ReadFailure read={turns} section={t("title")} />;
  if (!steps.ok) return <ReadFailure read={steps} section={t("title")} />;
  const { bars, total } = buildBars(turns.value.entries, steps.value.entries);
  if (bars.length === 0) {
    return (
      <p
        data-testid="waterfall-empty"
        className="max-w-prose text-sm text-muted-foreground"
      >
        {t("empty")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {total === null ? (
        <p
          data-testid="waterfall-unpriced"
          className="max-w-prose text-xs text-muted-foreground"
        >
          {t("unpriced")}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t.rich("total", {
            cost: () => <Money value={total} precision="exact" />,
          })}{" "}
          <span className={mono}>{total.basis ?? t("basisNotRecorded")}</span>
        </p>
      )}
      <ol data-testid="waterfall" className="flex flex-col gap-1.5">
        {bars.map((bar) => (
          <li
            key={`${bar.turn.seq}-${bar.turn.endSeq}`}
            data-testid="waterfall-bar"
            data-seq={bar.turn.seq}
            className="grid grid-cols-1 items-center gap-1 text-xs sm:grid-cols-[10rem_1fr_auto]"
          >
            <span className="flex flex-wrap gap-x-2">
              <span className={`${mono} break-all`}>{bar.turn.label}</span>
              <span className="text-muted-foreground">
                {t("steps", {
                  count: formatCount(bar.steps.length, locale),
                })}
              </span>
            </span>
            <span className="relative block h-5 w-full rounded bg-muted">
              {bar.width === null ? (
                <span className="absolute inset-y-0 left-0 flex items-center px-2 text-[11px] text-muted-foreground">
                  {t("noCost")}
                </span>
              ) : (
                <span
                  data-testid="waterfall-fill"
                  style={{
                    marginInlineStart: `${bar.offset * 100}%`,
                    width: `${Math.max(bar.width * 100, 0.5)}%`,
                  }}
                  className="relative block h-full rounded bg-foreground/70"
                >
                  <StepSegments bar={bar} />
                </span>
              )}
            </span>
            <span className="flex flex-wrap gap-x-3 tabular-nums">
              <span>{formatElapsed(bar.turn.elapsedMs, locale)}</span>
              {bar.turn.cost === null ? (
                <NoValue />
              ) : (
                <Money value={bar.turn.cost} precision="exact" />
              )}
              {bar.turn.cumulativeCost === null ? null : (
                <span className="text-muted-foreground">
                  {t.rich("running", {
                    cost: () => (
                      <Money
                        value={bar.turn.cumulativeCost!}
                        precision="exact"
                      />
                    ),
                  })}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {turns.value.complete ? null : (
        <p
          data-testid="waterfall-cut"
          className="max-w-prose text-xs text-muted-foreground"
        >
          {t("cut")}
        </p>
      )}
    </div>
  );
}
