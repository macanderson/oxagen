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
import {
  formatCount,
  formatDuration,
  formatRatio,
  ratioWidth,
} from "@/ui/money-format";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { NoValue } from "./parts";
import { entryKey } from "./transcript-model";
import { isWhole } from "./whole-transcript";

/** The narrowest a priced turn's bar is drawn, as a share of the run total. */
const MIN_BAR = 0.005;

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
 *
 * Not exported: `Waterfall` is its only caller, and its coverage is proven
 * through the rendered component (`waterfall.test.tsx`), not by calling this
 * directly.
 */
function buildBars(
  turns: readonly TranscriptEntry[],
  steps: readonly TranscriptEntry[],
): { bars: Bar[]; total: TranscriptEntry["cumulativeCost"] } {
  const last = turns.at(-1);
  const total = last === undefined ? null : last.cumulativeCost;
  // A sequence is a decimal digit string of no fixed width, so it is compared
  // by padding both sides to one length and reading them as text. Parsing it
  // into a number would lose a run past 2^53, and arithmetic on the digits
  // belongs to one module (INV-09).
  const before = (a: string, b: string): boolean => {
    const width = Math.max(a.length, b.length);
    return a.padStart(width, "0") <= b.padStart(width, "0");
  };
  // A subagent's step is numbered on its own chain, so the run's sequence
  // range says nothing about it. It belongs to the turn it was recorded in,
  // which the contract states on both reads alike (`turn`).
  const inRange = (step: TranscriptEntry, turn: TranscriptEntry): boolean =>
    step.subagent !== undefined
      ? turn.subagent === undefined && step.turn === turn.turn
      : before(turn.seq, step.seq) && before(step.seq, turn.endSeq);
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

/** The run's total up to and including one turn, or nothing where none was recorded. */
function RunningTotal({ cost }: { cost: TranscriptEntry["cumulativeCost"] }) {
  const t = useTranslations("run.waterfall");
  if (cost === null) return null;
  return (
    <span className="text-muted-foreground">
      {t.rich("running", {
        cost: () => <Money value={cost} precision="exact" />,
      })}
    </span>
  );
}

function StepSegments({ bar }: { bar: Bar }) {
  const t = useTranslations("run.waterfall");
  if (bar.steps.length === 0) return null;
  // Inside one turn the steps are split by their share of the turn's own cost,
  // so a segment says how much of this turn that step was.
  const whole = bar.turn.cost;
  if (whole === null) return null;
  const priced = bar.steps.flatMap((step) =>
    step.cost === null || step.cost.currency !== whole.currency
      ? []
      : [{ step, share: ratioOfIntegers(step.cost.micros, whole.micros) }],
  );
  if (priced.length === 0) return null;
  return (
    <span className="absolute inset-0 flex" aria-hidden="true">
      {priced.map(({ step, share }) => (
        <span
          key={`${entryKey(step)}-${step.endSeq}`}
          data-testid="waterfall-step"
          title={t("step", { label: step.label })}
          style={{ width: ratioWidth(share) }}
          className="border-r border-background/60 last:border-r-0"
        />
      ))}
    </span>
  );
}

/** cache_read ÷ (input_uncached + cache_read) over one turn's reported usage. */
function cacheHitOf(entry: TranscriptEntry): number | null {
  const usage = entry.usage;
  if (usage == null) return null;
  const read = usage.cacheRead;
  const fresh = usage.inputUncached;
  if (read === null || fresh === null || read + fresh === 0) return null;
  return read / (read + fresh);
}

/**
 * The waterfall's ledger (spec: Turn · Steps · Frames · Cache hit · Cost ·
 * Running total · Pinned), one row per bar and a total row that is the last
 * running total, so the table and the bars read one derivation. Nothing pins a
 * finding to a turn yet, so the Pinned cells say so.
 */
function WaterfallTable({
  bars,
  total,
}: {
  bars: readonly Bar[];
  total: TranscriptEntry["cumulativeCost"];
}) {
  const t = useTranslations("run.waterfall");
  const locale = useLocale();
  return (
    <Table
      label={t("table")}
      columns={[
        { label: t("columns.turn") },
        { label: t("columns.steps"), numeric: true },
        { label: t("columns.frames"), numeric: true },
        { label: t("columns.cacheHit"), numeric: true },
        { label: t("columns.cost"), numeric: true },
        { label: t("columns.running"), numeric: true },
        { label: t("columns.pinned") },
      ]}
    >
      {bars.map((bar) => {
        const hit = cacheHitOf(bar.turn);
        return (
          <tr key={`${entryKey(bar.turn)}-${bar.turn.endSeq}`}>
            <td className={`${cell} ${mono}`}>{bar.turn.label}</td>
            <td className={numericCell}>
              {formatCount(bar.steps.length, locale)}
            </td>
            <td className={numericCell}>
              {formatCount(bar.turn.frames, locale)}
            </td>
            <td className={numericCell}>
              {hit === null ? <NoValue /> : formatRatio(hit, locale)}
            </td>
            <td className={numericCell}>
              {bar.turn.cost === null ? (
                <NoValue />
              ) : (
                <Money value={bar.turn.cost} precision="exact" />
              )}
            </td>
            <td className={numericCell}>
              {bar.turn.cumulativeCost === null ? (
                <NoValue />
              ) : (
                <Money value={bar.turn.cumulativeCost} precision="exact" />
              )}
            </td>
            <td className={`${cell} text-muted-foreground`}>{t("noPin")}</td>
          </tr>
        );
      })}
      <tr data-testid="waterfall-total" className="font-semibold">
        <td className={cell} colSpan={5}>
          {t("totalRow")}
        </td>
        <td className={numericCell}>
          {total === null ? (
            <NoValue />
          ) : (
            t.rich("recorded", {
              cost: () => <Money value={total} precision="exact" />,
            })
          )}
        </td>
        <td className={cell} />
      </tr>
    </Table>
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
            key={`${entryKey(bar.turn)}-${bar.turn.endSeq}`}
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
                    marginInlineStart: ratioWidth(bar.offset),
                    // A priced turn always draws something: a bar too thin to
                    // see would read as a turn the waterfall left out.
                    width: ratioWidth(Math.max(bar.width, MIN_BAR)),
                  }}
                  className="relative block h-full rounded bg-foreground/70"
                >
                  <StepSegments bar={bar} />
                </span>
              )}
            </span>
            <span className="flex flex-wrap gap-x-3 tabular-nums">
              <span>{formatDuration(bar.turn.elapsedMs, locale)}</span>
              {bar.turn.cost === null ? (
                <NoValue />
              ) : (
                <Money value={bar.turn.cost} precision="exact" />
              )}
              <RunningTotal cost={bar.turn.cumulativeCost} />
            </span>
          </li>
        ))}
      </ol>
      <WaterfallTable bars={bars} total={total} />
      {isWhole(turns.value) && isWhole(steps.value) ? null : (
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
