// Spend › Wasted spend (spec "Wasted spend"; ADR-208, #5294): money whose
// frames show it bought nothing. Four tiles, By cause, and Runs with waste.
// list_waste answers every cause it priced in the period, largest first: a
// cache write no later call read, and the calls open findings claim, which
// add up to the Findings tab's unproductive spend. Each is drawn as recorded.
// A cause the design meters with no figure is listed as not recorded rather
// than drawn as a zero. Four have no detector yet. Retry loops and halted
// early drop that row once the answer carries the claimed cause that covers
// them. When no claimed call ran in the period while open findings claim
// calls outside it, the tab says how many and links to them. A run card
// carries what the cause cites: the run's session name over its id, and the
// cause. Its own amount is not on the contract yet.
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

type WasteCause = SpendWaste["causes"][number]["cause"];

/**
 * The causes the design meters, in its order, each with the cause on the
 * answer that records it. A row is drawn as not recorded until the answer
 * carries that cause. Four have none yet.
 */
const DESIGN_CAUSES: readonly {
  key:
    | "cacheMisses"
    | "correctivePrompts"
    | "retryLoops"
    | "contextBloat"
    | "idleWhileParked"
    | "haltedEarly";
  recordedAs: WasteCause | null;
}[] = [
  { key: "cacheMisses", recordedAs: null },
  { key: "correctivePrompts", recordedAs: null },
  { key: "retryLoops", recordedAs: "retry_loops" },
  { key: "contextBloat", recordedAs: null },
  { key: "idleWhileParked", recordedAs: null },
  // Spend with no outcome counts a run that stopped mid-step, beside one
  // whose pull request closed unmerged or was reverted.
  { key: "haltedEarly", recordedAs: "spend_with_no_outcome" },
];

/** The one cause a finding claim does not carry. */
const CACHE_CAUSE: WasteCause = "cache_write_never_read";

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
  const recorded = new Set(waste.causes.map((cause) => cause.cause));
  // No claimed call ran in the period, while open findings claim calls
  // outside it: the Findings tab lists them, and no cause here counts them.
  const outside =
    waste.findingsOutsidePeriod > 0 &&
    waste.causes.every((cause) => cause.cause === CACHE_CAUSE);
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
          <span className="flex flex-wrap gap-x-1 text-xs font-normal text-muted-foreground">
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
          <span className="text-lg">
            {largest === null ? t("noCause") : t(`cause.${largest.cause}`)}
          </span>
        </Tile>
      </TileStrip>
      {outside ? (
        <p data-testid="waste-outside" className="text-base text-muted-foreground">
          {t("outside", { count: waste.findingsOutsidePeriod })}{" "}
          <SafeLink
            to={routes.spend(at.org, at.ws, { tab: "findings" })}
            className="underline underline-offset-2"
          >
            {t("openFindings")}
          </SafeLink>
        </p>
      ) : null}
      <Panel
        id="spend-waste-causes"
        title={t("byCause")}
        footer={
          <div className="flex flex-col gap-2">
            <p>{t("causesNote")}</p>
            <NotBacked gap="rollup">{t("causesMissing")}</NotBacked>
          </div>
        }
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
                data-recorded="true"
                className="flex flex-col gap-1.5"
              >
                <span className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span>
                    <span className="font-semibold">
                      {t(`cause.${cause.cause}`)}
                    </span>{" "}
                    <span
                      className={`${mono} text-xs text-muted-foreground`}
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
                <span className="text-sm text-muted-foreground">
                  {t(`why.${cause.cause}`)}
                </span>
              </li>
            );
          })}
          {DESIGN_CAUSES.filter(
            (design) =>
              design.recordedAs === null || !recorded.has(design.recordedAs),
          ).map((design) => (
            <li
              key={design.key}
              data-cause={design.key}
              data-recorded="false"
              className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
            >
              <span className="font-semibold">
                {t(`designCause.${design.key}`)}
              </span>
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
                      className="truncate text-sm font-semibold"
                    >
                      {run.name ?? t("untitled")}
                    </span>
                    <span
                      data-testid="run-id"
                      className={`${mono} truncate text-xs text-dim`}
                    >
                      {run.runId}
                    </span>
                  </span>
                  <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-destructive/40 px-1.5 py-0.5 text-xs font-semibold text-destructive">
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
