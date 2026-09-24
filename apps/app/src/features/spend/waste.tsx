// Spend › Wasted spend (spec "Wasted spend"): money whose frames show it
// bought nothing. Four tiles, By cause, and Runs with waste. list_waste reads
// one cause today (a cache write no later call read), so it is printed as
// recorded, and the six causes the design meters are listed as not recorded
// yet (#2962) rather than drawn as zeros. A run card carries what the cause
// cites: the run and the cause; its own amount is not on the contract yet.
// Wasted is a claim about frames, not about outcomes.
import { useLocale, useTranslations } from "next-intl";
import { ratioOfMicros } from "@/data/contracts/money";
import type { SpendReport, SpendWaste } from "@/data/contracts/spend";
import { routes } from "@/shared/safe-path";
import { buttonSecondary, mono, panel } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatRatio, ratioWidth } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { BasisLabel, NotRecordedValue, Tile, TileStrip } from "./figures";
import { NotBacked } from "./not-backed";
import { Empty, Panel } from "./tables";
import type { SpendAt } from "./view";

/** The causes the design meters, in its order. None is on list_waste yet. */
const DESIGN_CAUSES = [
  "cacheMisses",
  "correctivePrompts",
  "retryLoops",
  "contextBloat",
  "idleWhileParked",
  "haltedEarly",
] as const;

export function WasteSection({
  waste,
  month,
  at,
}: {
  waste: SpendWaste;
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
  const runs = [
    ...new Map(
      waste.causes.flatMap((cause) =>
        cause.provingRuns.map((run) => [run, cause.cause] as const),
      ),
    ),
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
            {runs.map(([run, cause]) => (
              <li
                key={run}
                data-run={run}
                className={`${panel} flex flex-wrap items-center justify-between gap-3 px-3.5 py-3`}
              >
                <span className="flex min-w-0 flex-col gap-1.5">
                  <span className={`${mono} text-[12px] text-accent-text`}>
                    {run}
                  </span>
                  <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-destructive/40 px-1.5 py-0.5 text-[11px] font-semibold text-destructive">
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-destructive"
                    />
                    {t(`cause.${cause}`)}
                  </span>
                </span>
                <span className="flex flex-wrap gap-2">
                  <SafeLink
                    to={routes.run(at.org, at.ws, run)}
                    className={buttonSecondary}
                  >
                    {t("openRun")}
                  </SafeLink>
                  <SafeLink
                    to={routes.run(at.org, at.ws, run, { tab: "frames" })}
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
