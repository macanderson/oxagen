// The Run page's Summary panel and its six-figure stat row (mockup `pRun`,
// spec pages/run.md): Tokens, Prompts, Cost, Wasted, Wall clock, Cache hit.
//
// Each figure is read from the record or left saying why it is missing. The
// mockup computes waste from a heuristic over its fixture; here it is the
// rollup's cost times the share the rollup did not count as productive, shown
// only when the rollup holds both, and marked as derived. A prompt count read
// from a transcript that stopped short is a floor, and says so.
import { useLocale, useTranslations } from "next-intl";
import type { Cost } from "@/data/contracts/money";
import type { RunCost, RunTranscript } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import {
  linkText,
  mono,
  statNote,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { GeneratedSummary } from "@/ui/generated-summary";
import { Money } from "@/ui/money";
import { formatCount, formatDuration, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { NoValue, Panel } from "./parts";

export function SummaryPanel({
  run,
  org,
  ws,
}: {
  run: RunRow;
  org: string;
  ws: string;
}) {
  const t = useTranslations("run");
  return (
    <Panel
      title={t("summary.title")}
      aside={
        <SafeLink
          to={routes.run(org, ws, run.id, { tab: "transcript" })}
          className={`${linkText} text-xs`}
        >
          {t("summary.check")}
        </SafeLink>
      }
    >
      {run.summary === null ? (
        <p className="text-sm text-muted-foreground">{t("noSummary")}</p>
      ) : (
        <GeneratedSummary summary={run.summary} layout="block" />
      )}
    </Panel>
  );
}

function Stat({
  label,
  note,
  children,
}: {
  label: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={statTile}>
      <span className={statTerm}>{label}</span>
      <span className={`${statValue} min-w-0 truncate`}>{children}</span>
      {note === undefined ? null : <span className={statNote}>{note}</span>}
    </div>
  );
}

/**
 * The part of `cost` the rollup did not count as productive. Exact in micros:
 * the share is rounded to a millionth, never the money.
 */
function wasted(cost: Cost, productiveRatio: number): Cost {
  const share = BigInt(Math.round((1 - productiveRatio) * 1_000_000));
  return {
    micros: ((BigInt(cost.micros) * share) / 1_000_000n).toString(),
    currency: cost.currency,
    basis: cost.basis,
  };
}

export function StatRow({
  run,
  cost,
  transcript,
}: {
  run: RunRow;
  cost: Read<RunCost>;
  /** The whole-run transcript the Prompts figure counts from. */
  transcript: Read<RunTranscript>;
}) {
  const t = useTranslations("run.stats");
  const tc = useTranslations("run.cost");
  const locale = useLocale();
  const rollup = cost.ok ? cost.value.rollup : null;
  const tokens =
    rollup === null
      ? null
      : Object.values(rollup.tokens).reduce((sum, count) => sum + count, 0);
  const prompts = transcript.ok
    ? transcript.value.entries.filter((entry) => entry.kinds.includes("prompt"))
        .length
    : null;
  const runCost = rollup?.cost ?? run.cost;
  const missingRollup = cost.ok && rollup === null ? t("noRollup") : undefined;
  return (
    <section
      aria-label={t("label")}
      data-testid="run-stats"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6"
    >
      <Stat
        label={t("tokens")}
        note={
          rollup === null
            ? missingRollup
            : t("tokensNote", {
                output: formatCount(rollup.tokens.output, locale),
              })
        }
      >
        {tokens === null ? <NoValue /> : formatCount(tokens, locale)}
      </Stat>
      <Stat
        label={t("prompts")}
        note={
          transcript.ok && !transcript.value.complete
            ? t("promptsCut")
            : undefined
        }
      >
        {prompts === null ? (
          <NoValue />
        ) : transcript.ok && !transcript.value.complete ? (
          `${formatCount(prompts, locale)}+`
        ) : (
          formatCount(prompts, locale)
        )}
      </Stat>
      <Stat
        label={t("cost")}
        note={
          runCost === null ? undefined : (
            <span className={mono}>
              {runCost.basis ?? tc("basisNotRecorded")}
            </span>
          )
        }
      >
        {runCost === null ? <NoValue /> : <Money value={runCost} />}
      </Stat>
      <Stat
        label={t("wasted")}
        note={
          rollup?.cost == null || rollup.productiveRatio === null
            ? missingRollup
            : t("wastedNote")
        }
      >
        {rollup?.cost == null || rollup.productiveRatio === null ? (
          <NoValue />
        ) : (
          <Money value={wasted(rollup.cost, rollup.productiveRatio)} />
        )}
      </Stat>
      <Stat label={t("wallClock")}>
        {run.sealedAt === null
          ? t("running")
          : formatDuration(
              new Date(run.sealedAt).getTime() -
                new Date(run.startedAt).getTime(),
              locale,
            )}
      </Stat>
      <Stat label={t("cacheHit")} note={missingRollup}>
        {rollup?.cacheHitRate == null ? (
          <NoValue />
        ) : (
          formatRatio(rollup.cacheHitRate, locale)
        )}
      </Stat>
    </section>
  );
}
