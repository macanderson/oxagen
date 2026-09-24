// The Run page's Summary panel and its six-figure stat row (mockup `pRun`,
// spec pages/run.md): Tokens, Prompts, Cost, Wasted, Wall clock, Cache hit.
//
// Each figure is read from the record or left saying why it is missing. The
// mockup computes waste from a heuristic over its fixture; here it is the
// rollup's cost times the share the rollup did not count as productive, shown
// only when the rollup holds both, and marked as derived. A prompt count read
// from a transcript that stopped short is a floor, and says so.
import { useLocale, useTranslations } from "next-intl";
import { type Cost, shareOfMicros } from "@/data/contracts/money";
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
import { isWhole } from "./whole-transcript";

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
        // Turning enrichment off stops the generated summary only; the
        // harness title and every recorded fact stay on the page.
        <p className="text-sm text-muted-foreground">
          {run.enrichmentEnabled === false ? t("summaryOff") : t("noSummary")}
        </p>
      ) : (
        <GeneratedSummary summary={run.summary} layout="block" />
      )}
      {run.enrichmentError === undefined ? null : (
        <p
          data-testid="run-summary-failed"
          className="text-xs text-muted-foreground"
        >
          {t("summaryFailed", { reason: run.enrichmentError })}
        </p>
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
function wasted(
  cost: Cost | null,
  productiveRatio: number | null,
): Cost | null {
  if (cost === null || productiveRatio === null) return null;
  const part = shareOfMicros(cost, 1 - productiveRatio);
  return part === null ? null : { ...part, basis: cost.basis };
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
  const tr = useTranslations("run");
  const locale = useLocale();
  const rollup = cost.ok ? cost.value.rollup : null;
  const waste = wasted(rollup?.cost ?? null, rollup?.productiveRatio ?? null);
  // The recorder's end time, else the seal, which is receipt time.
  const endedAt = run.endedAt ?? run.sealedAt;
  // Before the rollup rebuilds a sealed run, the session's own sums over its
  // llm_call frames stand in, so a live run shows its tokens too. Those sums
  // are labelled provisional, since the rollup may still reprice or recount.
  const reported = run.reportedTokens ?? null;
  const tokens =
    rollup === null
      ? reported === null
        ? null
        : reported.input +
          reported.output +
          reported.cacheRead +
          reported.cacheWrite
      : Object.values(rollup.tokens).reduce((sum, count) => sum + count, 0);
  const prompts = transcript.ok
    ? transcript.value.entries.filter((entry) => entry.kinds.includes("prompt"))
        .length
    : null;
  const runCost = rollup?.cost ?? run.cost;
  // A finalized rollup wins. Otherwise the agent-reported cost is provisional.
  const displayedCost = runCost ?? run.reportedCost ?? null;
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
            ? reported === null
              ? missingRollup
              : t("tokensProvisional")
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
          transcript.ok && !isWhole(transcript.value)
            ? t("promptsCut")
            : undefined
        }
      >
        {prompts === null ? (
          <NoValue />
        ) : transcript.ok && !isWhole(transcript.value) ? (
          `${formatCount(prompts, locale)}+`
        ) : (
          formatCount(prompts, locale)
        )}
      </Stat>
      <Stat
        label={t("cost")}
        note={
          displayedCost === null ? undefined : (
            <span className={mono}>
              {runCost === null
                ? tr("costReportedProvisional")
                : tr("costFinalized", {
                    basis: runCost.basis ?? tc("basisNotRecorded"),
                  })}
            </span>
          )
        }
      >
        {displayedCost === null ? <NoValue /> : <Money value={displayedCost} />}
      </Stat>
      <Stat
        label={t("wasted")}
        note={waste === null ? missingRollup : t("wastedNote")}
      >
        {waste === null ? <NoValue /> : <Money value={waste} />}
      </Stat>
      <Stat label={t("wallClock")}>
        {/* Keyed on the status, as the header's when line is. The clock
            ends at the recorder's end time, falling back to the seal; a run
            with neither has no wall clock to show. */}
        {run.status === "live" ? (
          t("running")
        ) : endedAt === null ? (
          <NoValue />
        ) : (
          formatDuration(
              new Date(endedAt).getTime() -
                new Date(run.startedAt).getTime(),
              locale,
            )
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
