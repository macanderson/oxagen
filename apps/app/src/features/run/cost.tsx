// The Cost tab (#2962; spec pages/run.md Cost, §12.6, §12.7; ADR-060), in the
// spec's order: Model fit, the instruments strip, Spend by area, Tool calls,
// the Waterfall, Spend by token class and Prompt composition.
//
// The run's `cost.run_totals` row is rebuilt from the frames while the run
// records them and again when it seals (#3980). A row built from an open run
// is an estimate, and the tab says so above its figures. Before the first
// rollup the tab says that in words rather than printing zeros: a zero is a
// figure the rollup measured, and "not yet rolled up" is not.
//
// Every money figure carries the basis that says who observed it (INV-10).
// The instruments, the token-class table and the stat row above the tabs all
// read the same rollup, so no two of them can disagree. Where the rollup has
// no column for what a panel shows (the split by area, prompt composition, a
// tool's wall clock or failures, the fit reading), the panel names the gap
// rather than drawing a figure the record does not hold.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  compareIntegers,
  ratioOfIntegers,
  shareOfMicros,
} from "@/data/contracts/money";
import type {
  RunCost,
  RunCostRollup,
  RunTranscript,
  TokenCounts,
} from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { Badge } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import {
  formatCount,
  formatDuration,
  formatOneDecimal,
  formatRatio,
  ratioWidth,
} from "@/ui/money-format";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { NoValue, Panel } from "./parts";
import { tokensIn, tokensOut } from "./stats";
import { Waterfall } from "./waterfall";
import { SpendByArea, toolFamily } from "./work";

/** The spec's token classes, in its order; the 1h write is §12.6's sixth. */
const TOKEN_CLASSES = [
  ["inputUncached", "input_uncached"],
  ["cacheRead", "cache_read"],
  ["cacheWrite5m", "cache_write_5m"],
  ["cacheWrite1h", "cache_write_1h"],
  ["output", "output"],
  ["reasoning", "reasoning"],
] as const satisfies readonly (readonly [keyof TokenCounts, string])[];

type Place = { org: string; ws: string; runId: string };

/**
 * Model fit (spec: first on the Cost tab). The reading is a light-tier
 * classifier over the sealed run that nothing runs yet (G14), and the effort
 * setting is read out of a request body the record does not keep (G6). Each
 * card names its gap and offers nothing, so no change is proposed from a
 * reading that was never made.
 */
function ModelFit({ run }: { run: RunRow }) {
  const t = useTranslations("run.cost.fit");
  return (
    <section
      aria-labelledby="run-fit-title"
      data-testid="run-model-fit"
      className="app-panel min-w-0 overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h3 id="run-fit-title" className="text-[13.5px] font-semibold">
          {t("title")}
        </h3>
        <span className="rounded-md border border-border px-2 py-0.5 text-[10.5px] font-semibold text-muted-foreground">
          {t("generated")}
        </span>
      </div>
      <div className="border-b border-border px-4 py-3.5">
        <p className="text-sm font-semibold">
          {t("model", { model: run.model?.slug ?? t("modelNotRecorded") })}
        </p>
        <p
          data-gap="G14"
          className="mt-1.5 text-[12.5px] text-muted-foreground"
        >
          {t("modelNone")}
        </p>
      </div>
      <div className="border-b border-border px-4 py-3.5">
        <p className="text-sm font-semibold">{t("effort")}</p>
        <p data-gap="G6" className="mt-1.5 text-[12.5px] text-muted-foreground">
          {t("effortNone")}
        </p>
      </div>
      <p className="px-4 py-3.5 text-xs text-muted-foreground">{t("footer")}</p>
    </section>
  );
}

function Instrument({
  label,
  basis,
  value,
  children,
}: {
  label: string;
  basis?: ReactNode;
  value: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid="run-instrument"
      className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card px-[15px] py-[13px]"
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim">
          {label}
        </span>
        {basis === undefined ? null : (
          <span className={`${mono} text-[10.5px] text-muted-foreground`}>
            {basis}
          </span>
        )}
      </span>
      <span className="text-xl font-bold tabular-nums">{value}</span>
      {children === undefined ? null : (
        <span className="flex flex-col gap-0.5 text-[11.5px] text-muted-foreground">
          {children}
        </span>
      )}
    </div>
  );
}

/**
 * One field of an instrument the record does not hold: a muted line that says
 * what is missing and names the gap, never a zero or a blank (spec: 🟡 rows
 * render NotBacked for the fields that do not exist).
 */
function Gap({ gap, children }: { gap: string; children: ReactNode }) {
  return (
    <span data-gap={gap} data-testid="instrument-gap">
      {children}
    </span>
  );
}

/**
 * Cost per turn as a small column chart, one column per turn the per-turn
 * ledger priced, tallest at the dearest. Null when no turn carries a cost.
 */
function PerTurnChart({ turns }: { turns: Read<RunTranscript> }) {
  const t = useTranslations("run.cost.instruments");
  if (!turns.ok) return null;
  const priced = turns.value.entries.flatMap((entry) =>
    entry.cost === null ? [] : [{ id: entry.seq, micros: entry.cost.micros }],
  );
  if (priced.length === 0) return null;
  const top = priced.reduce(
    (max, turn) => (compareIntegers(turn.micros, max) > 0 ? turn.micros : max),
    "0",
  );
  return (
    <span
      role="img"
      aria-label={t("perTurnChart", { count: priced.length })}
      data-testid="instrument-per-turn"
      className="flex h-6 items-end gap-[2px] pt-1"
    >
      {priced.map((turn) => (
        <span
          key={turn.id}
          className="w-1.5 rounded-sm bg-foreground/50"
          style={{
            height: `${String(compareIntegers(top, "0") === 0 ? 0 : Math.max(8, Math.floor(ratioOfIntegers(turn.micros, top) * 100)))}%`,
          }}
        />
      ))}
    </span>
  );
}

/** The dearest turn the per-turn ledger recorded; null when no turn carried a cost. */
function dearestTurn(turns: Read<RunTranscript>) {
  if (!turns.ok) return null;
  let best: RunTranscript["entries"][number] | null = null;
  for (const entry of turns.value.entries) {
    if (entry.cost === null) continue;
    if (
      best?.cost == null ||
      compareIntegers(entry.cost.micros, best.cost.micros) > 0
    )
      best = entry;
  }
  return best;
}

function Instruments({
  run,
  rollup,
  turns,
  at,
}: {
  run: RunRow;
  rollup: RunCostRollup;
  turns: Read<RunTranscript>;
  at: number;
}) {
  const t = useTranslations("run.cost.instruments");
  const locale = useLocale();
  const count = (value: number) => formatCount(value, locale);
  const cost = rollup.cost;
  const perTurn =
    cost === null || rollup.turns === null || rollup.turns === 0
      ? null
      : shareOfMicros(cost, 1 / rollup.turns);
  const dearest = dearestTurn(turns);
  const input = tokensIn(rollup.tokens);
  const output = tokensOut(rollup.tokens);
  const wall =
    (run.sealedAt === null ? at : new Date(run.sealedAt).getTime()) -
    new Date(run.startedAt).getTime();
  const families = new Set(rollup.byTool.map((tool) => toolFamily(tool.name)));
  return (
    <div
      data-testid="run-instruments"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
    >
      <Instrument
        label={t("cost")}
        basis={cost?.basis ?? undefined}
        value={cost === null ? <NoValue /> : <Money value={cost} />}
      >
        <span>
          {t("perTurn")}{" "}
          {perTurn === null ? <NoValue /> : <Money value={perTurn} />}
        </span>
        <span>
          {t("dearestTurn")}{" "}
          {dearest?.cost == null ? (
            <NoValue />
          ) : (
            <>
              {dearest.label} <Money value={dearest.cost} />
            </>
          )}
        </span>
        <Gap gap="G3">{t("medianNotRecorded")}</Gap>
        <PerTurnChart turns={turns} />
        <span>
          {t("cacheHit")}{" "}
          {rollup.cacheHitRate === null ? (
            <NoValue />
          ) : (
            formatRatio(rollup.cacheHitRate, locale)
          )}
        </span>
        <Gap gap="G3">{t("savedNotRecorded")}</Gap>
      </Instrument>
      <Instrument
        label={t("wallClock")}
        basis={run.sealedAt === null ? t("soFar") : t("startToSeal")}
        value={formatDuration(Math.max(0, wall), locale)}
      >
        <Gap gap="G6">{t("splitNotRecorded")}</Gap>
        <Gap gap="G6">{t("batchedNotRecorded")}</Gap>
      </Instrument>
      <Instrument
        label={t("tokens")}
        basis={t("inAndOut")}
        value={count(input + output)}
      >
        <span data-testid="instrument-tokens-split">
          {t("inOut", { in: count(input), out: count(output) })}
        </span>
        <span>
          {t("tokenSplit", {
            cacheRead: count(rollup.tokens.cacheRead),
            fresh: count(rollup.tokens.inputUncached),
            output: count(output),
          })}
        </span>
        <span>
          {rollup.modelCalls === 0
            ? t("noModelCall")
            : t("perCall", {
                tokens: count(Math.round((input + output) / rollup.modelCalls)),
              })}
        </span>
        <Gap gap="G3">{t("priceNotRecorded")}</Gap>
      </Instrument>
      <Instrument
        label={t("shape")}
        value={t("shapeValue", {
          turns: rollup.turns === null ? "–" : count(rollup.turns),
          steps: count(rollup.steps),
          frames: count(run.frames),
        })}
      >
        <span>
          {rollup.turns === null || rollup.turns === 0 ? (
            <NoValue />
          ) : (
            t("stepsPerTurn", {
              value: formatOneDecimal(rollup.steps / rollup.turns, locale),
            })
          )}
        </span>
        <Gap gap="G6">{t("batchesNotRecorded")}</Gap>
      </Instrument>
      <Instrument label={t("toolCalls")} value={count(rollup.toolCalls)}>
        <span>{t("families", { count: families.size })}</span>
        <Gap gap="G6">{t("failedNotRecorded")}</Gap>
        <Gap gap="G6">{t("parallelNotRecorded")}</Gap>
      </Instrument>
      <Instrument
        label={t("productive")}
        value={
          rollup.productiveRatio === null ? (
            <NoValue />
          ) : (
            formatRatio(rollup.productiveRatio, locale)
          )
        }
      >
        <span>{t("productiveNote")}</span>
        <Gap gap="G3">{t("advancedNotRecorded")}</Gap>
        <Gap gap="G3">{t("trendNotRecorded")}</Gap>
      </Instrument>
    </div>
  );
}

/** Calls by family, from the rollup's per-tool call counts. */
function ToolCalls({ rollup }: { rollup: RunCostRollup }) {
  const t = useTranslations("run.cost.tools");
  const locale = useLocale();
  const byFamily = new Map<string, number>();
  for (const tool of rollup.byTool) {
    const family = toolFamily(tool.name);
    byFamily.set(family, (byFamily.get(family) ?? 0) + tool.calls);
  }
  const rows = [...byFamily.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, calls]) => sum + calls, 0);
  return (
    <Panel title={t("title")}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">{t("byFamily")}</h4>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("none")}</p>
          ) : (
            <Table
              label={t("byFamily")}
              columns={[
                { label: t("columns.family") },
                { label: t("columns.calls"), numeric: true },
                { label: t("columns.share"), numeric: true },
                { label: t("columns.wallClock"), numeric: true },
                { label: t("columns.failed"), numeric: true },
              ]}
            >
              {rows.map(([family, calls]) => (
                <tr key={family} data-testid="cost-family-row">
                  <td className={`${cell} ${mono}`}>{family}</td>
                  <td className={numericCell}>{formatCount(calls, locale)}</td>
                  <td className={numericCell}>
                    {total === 0 ? (
                      <NoValue />
                    ) : (
                      formatRatio(calls / total, locale)
                    )}
                  </td>
                  <td className={numericCell}>
                    <NoValue />
                  </td>
                  <td className={numericCell}>
                    <NoValue />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-semibold">{t("batches")}</h4>
          <p data-gap="G6" className="text-sm text-muted-foreground">
            {t("batchesNone")}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-semibold">{t("prefetch")}</h4>
          <p data-gap="G6" className="text-sm text-muted-foreground">
            {t("prefetchNone")}
          </p>
        </div>
      </div>
    </Panel>
  );
}

/**
 * Spend by token class (§12.6). Tokens are the rollup's; the money per class
 * is not on `cost.run_totals` (G3), so the Cost cells say so and the share is
 * the class's share of the run's tokens. The total row is the sum of the
 * rows, the same figure the Tokens box above the tabs prints.
 */
function TokenClasses({ rollup }: { rollup: RunCostRollup }) {
  const t = useTranslations("run.cost.classes");
  const tc = useTranslations("run.cost");
  const locale = useLocale();
  const total = TOKEN_CLASSES.reduce(
    (sum, [key]) => sum + rollup.tokens[key],
    0,
  );
  return (
    <Panel title={t("title")}>
      <Table
        label={t("title")}
        columns={[
          { label: t("columns.class") },
          { label: t("columns.tokens"), numeric: true },
          { label: t("columns.cost"), numeric: true },
          { label: t("columns.share"), numeric: true },
        ]}
      >
        {TOKEN_CLASSES.map(([key, name]) => (
          <tr key={key} data-testid="cost-class-row">
            <td className={`${cell} ${mono}`}>{name}</td>
            <td className={numericCell}>
              {formatCount(rollup.tokens[key], locale)}
            </td>
            <td className={numericCell}>
              <NoValue />
            </td>
            <td className={numericCell}>
              {total === 0 ? (
                <NoValue />
              ) : (
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="relative hidden h-1.5 w-16 rounded bg-muted sm:block"
                  >
                    <span
                      className="absolute inset-y-0 left-0 rounded bg-foreground/60"
                      style={{ width: ratioWidth(rollup.tokens[key] / total) }}
                    />
                  </span>
                  {formatRatio(rollup.tokens[key] / total, locale)}
                </span>
              )}
            </td>
          </tr>
        ))}
        <tr data-testid="cost-class-total" className="font-semibold">
          <td className={cell}>{t("total")}</td>
          <td className={numericCell}>{formatCount(total, locale)}</td>
          <td className={numericCell}>
            {rollup.cost === null ? (
              <NoValue />
            ) : (
              <span className="inline-flex flex-col items-end">
                <Money value={rollup.cost} precision="exact" />
                <span
                  data-testid="cost-class-basis"
                  className={`${mono} text-[10.5px] font-normal text-muted-foreground`}
                >
                  {rollup.cost.basis ?? tc("basisNotRecorded")}
                </span>
              </span>
            )}
          </td>
          <td className={numericCell}>{total === 0 ? null : "100%"}</td>
        </tr>
      </Table>
      <p className="pt-3 text-xs text-muted-foreground">{t("note")}</p>
    </Panel>
  );
}

/**
 * When the rollup built the row and what it priced with. A row built while the
 * run was open is an estimate (#3980), and the line says so first, since
 * every figure above it reads from that row.
 */
function RolledUp({ rollup }: { rollup: RunCostRollup }) {
  const t = useTranslations("run.cost");
  const format = useFormatter();
  return (
    <p className={`${mono} text-[11px] text-muted-foreground`}>
      {rollup.isEstimate === true ? (
        <span
          data-testid="cost-estimate"
          className="mb-1 block max-w-prose font-sans text-sm"
        >
          {t("estimate")}
        </span>
      ) : null}
      {t("rolledUp", {
        at: format.dateTime(new Date(rollup.rolledUpAt), {
          dateStyle: "medium",
          timeStyle: "short",
        }),
        prices:
          rollup.priceEntryIds.length === 0
            ? t("pricesNotRecorded")
            : rollup.priceEntryIds.join(", "),
      })}
    </p>
  );
}

export function CostSection({
  run,
  read,
  turns,
  steps,
  at,
  place,
}: {
  run: RunRow;
  read: Read<RunCost>;
  /** The transcript at the `turns` zoom: the waterfall's bars. */
  turns: Read<RunTranscript>;
  /** The transcript at the `steps` zoom: what sits inside each bar. */
  steps: Read<RunTranscript>;
  /** The instant a live run's wall clock is read against. */
  at: number;
  place: Place;
}) {
  const t = useTranslations("run.cost");
  const waterfall = useTranslations("run.waterfall");
  const rollup = read.ok ? read.value.rollup : null;
  return (
    <div className="flex flex-col gap-4">
      <ModelFit run={run} />
      {!read.ok ? (
        <Panel title={t("title")}>
          <ReadFailure read={read} section={t("title")} />
        </Panel>
      ) : rollup === null ? (
        <Panel title={t("title")}>
          <p
            data-testid="cost-not-rolled-up"
            className="max-w-prose text-sm text-muted-foreground"
          >
            {t("notRolledUp")}
          </p>
        </Panel>
      ) : (
        <>
          <Instruments run={run} rollup={rollup} turns={turns} at={at} />
          <RolledUp rollup={rollup} />
        </>
      )}
      <SpendByArea read={read} place={place} full />
      {rollup === null ? null : <ToolCalls rollup={rollup} />}
      <Panel title={waterfall("title")}>
        <Waterfall turns={turns} steps={steps} />
      </Panel>
      {rollup === null ? null : <TokenClasses rollup={rollup} />}
      <Panel
        title={t("composition.title")}
        aside={
          <Badge tone="quiet" dot={false}>
            {t("composition.notRecorded")}
          </Badge>
        }
      >
        <p data-gap="G3" className="max-w-prose text-sm text-muted-foreground">
          {t("composition.none")}
        </p>
      </Panel>
    </div>
  );
}
