// Spend › Wasted spend (spec "Wasted spend"): money whose frames show it
// bought nothing. Four tiles, By cause, and Runs with waste. list_waste reads
// one cause today (a cache write no later call read), so it is printed as
// recorded. Retry loops are recorded too, from the open retry_loops findings
// (F15). The five other causes the design meters are listed as not recorded
// yet (#2962) rather than drawn as zeros. A run card carries what the cause
// cites: the run's session name over its id, and the cause. Its own amount is
// not on the contract yet.
// Wasted spend is read from frames.
import { useLocale, useTranslations } from "next-intl";
import { ratioOfMicros } from "@/data/contracts/money";
import type {
  SpendFinding,
  SpendReport,
  SpendWaste,
} from "@/data/contracts/spend";
import { routes } from "@/shared/safe-path";
import { buttonSecondary, mono, panel } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatRatio, ratioWidth } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { BasisLabel, NotRecordedValue, Tile, TileStrip } from "./figures";
import { NotBacked } from "./not-backed";
import { savingOf } from "./rollup";
import { Empty, Panel } from "./tables";
import type { SpendAt } from "./view";

/** The causes the design meters that nothing records yet, in its order. */
const DESIGN_CAUSES = [
  "cacheMisses",
  "correctivePrompts",
  "contextBloat",
  "idleWhileParked",
  "haltedEarly",
] as const;

/**
 * Retry loops, from the open `retry_loops` findings: what the requests that
 * only retried a failing call cost, and the runs they cite. The findings cover
 * the findings job's trailing 30 days, not this period, so the row draws no
 * share bar. Not recorded when the findings read did not answer.
 */
function RetryLoops({
  findings,
  at,
}: {
  findings: SpendFinding[] | null;
  at: SpendAt;
}) {
  const t = useTranslations("spend.waste");
  const locale = useLocale();
  if (findings === null)
    return (
      <li
        data-cause="retryLoops"
        data-recorded="false"
        className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]"
      >
        <span className="font-semibold">{t("designCause.retryLoops")}</span>
        <NotRecordedValue />
      </li>
    );
  const loops = findings.filter((finding) => finding.kind === "retry_loops");
  const saving = savingOf(loops);
  const runs = loops.reduce((n, finding) => n + finding.runs, 0);
  return (
    <li
      data-cause="retryLoops"
      data-recorded="true"
      className="flex flex-col gap-1.5"
    >
      <span className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
        <span>
          <span className="font-semibold">{t("designCause.retryLoops")}</span>{" "}
          {loops.length === 0 ? null : (
            <span className={`${mono} text-[11px] text-muted-foreground`}>
              {t("causeRuns", { runs: formatCount(runs, locale) })}
            </span>
          )}
        </span>
        {loops.length === 0 ? (
          <span className="text-muted-foreground">{t("retryLoopsNone")}</span>
        ) : saving === null ? (
          <span className="font-semibold">
            {t("retryLoopsFindings", {
              findings: formatCount(loops.length, locale),
            })}
          </span>
        ) : (
          <span className="font-semibold">
            <Money value={saving} /> <BasisLabel basis={saving.basis} />
          </span>
        )}
      </span>
      <span className="text-[12px] text-muted-foreground">
        {t("retryLoopsWhy")}{" "}
        <SafeLink
          to={routes.spend(at.org, at.ws, { tab: "findings" })}
          className="underline underline-offset-2"
        >
          {t("retryLoopsOpen")}
        </SafeLink>
      </span>
    </li>
  );
}

export function WasteSection({
  waste,
  findings,
  month,
  at,
}: {
  waste: SpendWaste;
  /** The open findings, for the retry loops row; null when the read did not answer. */
  findings: SpendFinding[] | null;
  month: SpendReport;
  at: SpendAt;
}) {
  const t = useTranslations("spend.waste");
  const locale = useLocale();
  const largest =
    waste.largestCause === null
      ? null
      : (waste.causes.find((cause) => cause.cause === waste.largestCause) ??
        null);
  // One card per run, in the order the causes first cite it.
  const runs = [
    ...new Map(
      waste.causes.flatMap((cause) =>
        cause.provingRuns.map(
          (run) => [run.runId, { ...run, cause: cause.cause }] as const,
        ),
      ),
    ).values(),
  ];
  return (
    <>
      <TileStrip>
        <Tile term={t("wasted")}>
          {waste.wasted === null ? (
            <NotRecordedValue />
          ) : (
            <span className="text-destructive">
              <Money value={waste.wasted} />
            </span>
          )}
          <span className="flex flex-wrap gap-x-1 text-[11.5px] font-normal text-muted-foreground">
            <BasisLabel basis={waste.wasted?.basis ?? null} />
            {waste.wasted === null ? null : (
              <span>{t("currency", { currency: waste.wasted.currency })}</span>
            )}
          </span>
        </Tile>
        <Tile term={t("share")} note={t("shareNote")}>
          {waste.share === null ? (
            <NotRecordedValue />
          ) : (
            formatRatio(waste.share, locale)
          )}
        </Tile>
        <Tile
          term={t("runsWithWaste")}
          note={t("runsNote", { runs: formatCount(month.total.runs, locale) })}
        >
          {formatCount(waste.runsWithWaste, locale)}
        </Tile>
        <Tile
          term={t("largestCause")}
          note={
            largest === null
              ? undefined
              : t("largestNote", { runs: formatCount(largest.runs, locale) })
          }
        >
          <span className="text-[17px]">
            {largest === null ? t("noCause") : t(`cause.${largest.cause}`)}
          </span>
        </Tile>
      </TileStrip>
      <Panel
        id="spend-waste-causes"
        title={t("byCause")}
        footer={<NotBacked gap="rollup">{t("causesMissing")}</NotBacked>}
      >
        <ul className="flex flex-col gap-3.5 px-4 py-3.5">
          {waste.causes.map((cause) => {
            const share =
              waste.wasted === null
                ? null
                : ratioOfMicros(cause.wasted, waste.wasted);
            return (
              <li
                key={cause.cause}
                data-cause={cause.cause}
                className="flex flex-col gap-1.5"
              >
                <span className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
                  <span>
                    <span className="font-semibold">
                      {t(`cause.${cause.cause}`)}
                    </span>{" "}
                    <span
                      className={`${mono} text-[11px] text-muted-foreground`}
                    >
                      {t("causeRuns", {
                        runs: formatCount(cause.runs, locale),
                      })}
                    </span>
                  </span>
                  <span className="font-semibold">
                    <Money value={cause.wasted} />{" "}
                    <BasisLabel basis={cause.wasted.basis} />
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className="block h-1.5 w-full overflow-hidden rounded-full bg-muted"
                >
                  <span
                    className="block h-full bg-destructive"
                    style={{ width: ratioWidth(share ?? 0) }}
                  />
                </span>
                <span className="text-[12px] text-muted-foreground">
                  {t(`why.${cause.cause}`)}
                </span>
              </li>
            );
          })}
          <RetryLoops findings={findings} at={at} />
          {DESIGN_CAUSES.map((cause) => (
            <li
              key={cause}
              data-cause={cause}
              data-recorded="false"
              className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]"
            >
              <span className="font-semibold">{t(`designCause.${cause}`)}</span>
              <NotRecordedValue />
            </li>
          ))}
        </ul>
      </Panel>
      <Panel
        id="spend-waste-runs"
        title={t("runs")}
        footer={
          <span className="flex flex-col gap-2">
            <span>{t("note")}</span>
            <NotBacked gap="rollup">{t("runAmountMissing")}</NotBacked>
          </span>
        }
      >
        {runs.length === 0 ? (
          <Empty>{t("none")}</Empty>
        ) : (
          <ul className="flex flex-col gap-2.5 p-3.5">
            {runs.map((run) => (
              <li
                key={run.runId}
                data-run={run.runId}
                className={`${panel} flex flex-wrap items-center justify-between gap-3 px-3.5 py-3`}
              >
                <span className="flex min-w-0 flex-col gap-1.5">
                  <span className="flex min-w-0 flex-col">
                    <span
                      title={run.name ?? undefined}
                      className="truncate text-[13px] font-semibold"
                    >
                      {run.name ?? t("untitled")}
                    </span>
                    <span
                      data-testid="run-id"
                      className={`${mono} truncate text-[11px] text-dim`}
                    >
                      {run.runId}
                    </span>
                  </span>
                  <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-destructive/40 px-1.5 py-0.5 text-[11px] font-semibold text-destructive">
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-destructive"
                    />
                    {t(`cause.${run.cause}`)}
                  </span>
                </span>
                <span className="flex flex-wrap gap-2">
                  <SafeLink
                    to={routes.run(at.org, at.ws, run.runId)}
                    className={buttonSecondary}
                  >
                    {t("openRun")}
                  </SafeLink>
                  <SafeLink
                    to={routes.run(at.org, at.ws, run.runId, {
                      tab: "frames",
                    })}
                    className={buttonSecondary}
                  >
                    {t("showFrames")}
                  </SafeLink>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
