// Tool calls (pages/run.md, Cost; the mockup's `callsPanel`): the run's tool
// calls by family, how many tools each batch asked for, and speculative
// prefetch. Families, batches and their wall clock come from `runMetrics`,
// which reads them off the whole-run transcript: a batch is the calls between
// two model steps, and a family is the tool group the transcript marks.
//
// Speculative prefetch is not recorded. Oxagen writes no frame for a read a
// harness starts before the step is final, so the panel draws its figure,
// its bar and its four rows and says "not recorded" in each, rather than
// seeding them.
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/ui/badge";
import { eyebrowQuiet } from "@/ui/control-styles";
import {
  formatCount,
  formatDuration,
  formatRatio,
  ratioWidth,
} from "@/ui/money-format";
import { cell, headCell, numericCell } from "@/ui/table";
import { fillBar, fillBarFill } from "./instruments";
import type { Batches, Family, RunMetrics } from "./metrics";
import { Fact, Facts, NoValue, Note, Panel } from "./parts";
import { ToolIcon } from "./tool-icon";

/** `.cc { grid-template-columns:minmax(0,1fr) minmax(0,1fr) }`; one column on a phone. */
const columns = "grid grid-cols-1 md:grid-cols-2";
/** `.cc-c { padding:14px 16px; border-right:1px solid var(--border) }`, `.cc-c:last-child { border-right:0 }` */
const column =
  "min-w-0 border-b border-border px-4 py-3.5 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0";
/** `.cc-c.wide { grid-column:1/-1; border-right:0; border-bottom:1px solid var(--border) }` */
const wideColumn =
  "min-w-0 border-b border-border px-4 py-3.5 md:col-span-2 md:border-r-0";
/** `.cc-c table { min-width:460px }`, `table.narrow`: the family table scrolls inside its column. */
const familyTable = "w-full min-w-[460px] border-collapse text-[13px]";
/** `.fcell .ti { 24px; border-radius:6px; color:var(--tc,var(--muted)); background:<that at 14%> }` */
const familyIcon =
  "grid size-6 flex-none place-items-center rounded-md bg-muted-foreground/15 text-muted-foreground";
/** `.fcell .fx b { 12.5px; 600 }` over `.fcell .fx span { mono; 10.5px; muted }` */
const familyName =
  "whitespace-nowrap text-[12.5px] font-semibold text-foreground";
const familyTools =
  "whitespace-nowrap font-mono text-[10.5px] text-muted-foreground";
/** `.hrow { grid-template-columns:8ch 1fr auto; gap:9px; font-size:11.5px; color:var(--muted) }` */
const histRow =
  "grid grid-cols-[8ch_minmax(0,1fr)_auto] items-center gap-[9px] text-[11.5px] text-muted-foreground";
/** `.hrow .hk`, `.hrow .hv { font-family:var(--mono); font-size:11px }`; the value in the ink. */
const histKey = "font-mono text-[11px]";
const histValue = "font-mono text-[11px] tabular-nums text-foreground";
/** `.spec .sv { font-size:22px; font-weight:700; letter-spacing:-.02em; margin-bottom:7px }` */
const specValue = "mb-[7px] text-[22px] font-bold tracking-[-0.02em]";
/** `.stk { height:8px; border-radius:4px }` drawn as an empty track: no prefetch was recorded to fill it. */
const emptyTrack = "block h-2 rounded bg-hl";

function FamilyTable({ families }: { families: readonly Family[] }) {
  const t = useTranslations("run.cost");
  const locale = useLocale();
  const widest = families[0]?.calls ?? 1;
  return (
    <div className="min-w-0 overflow-x-auto">
      <table aria-label={t("calls.byFamily")} className={familyTable}>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={`${headCell} text-left`}>
              {t("calls.columns.family")}
            </th>
            <th scope="col" className={`${headCell} text-right`}>
              {t("calls.columns.calls")}
            </th>
            <th
              scope="col"
              aria-label={t("calls.columns.bar")}
              className={headCell}
            />
            <th scope="col" className={`${headCell} text-right`}>
              {t("calls.columns.share")}
            </th>
            <th scope="col" className={`${headCell} text-right`}>
              {t("calls.columns.wall")}
            </th>
            <th scope="col" className={`${headCell} text-right`}>
              {t("calls.columns.failed")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {families.map((family) => (
            <tr key={family.group} data-testid="family-row">
              <td className={`${cell} w-[1%] whitespace-nowrap pr-3.5`}>
                <span className="flex min-w-0 items-center gap-[9px]">
                  <span className={familyIcon}>
                    <ToolIcon group={family.group} size="md" />
                  </span>
                  <span className="grid min-w-0 leading-[1.3]">
                    <b className={familyName}>
                      {t(`families.${family.group}`)}
                    </b>
                    <span className={familyTools}>
                      {t("calls.distinct", { count: family.tools })}
                    </span>
                  </span>
                </span>
              </td>
              <td className={numericCell}>
                {formatCount(family.calls, locale)}
              </td>
              <td className={`${cell} min-w-[70px]`}>
                <span
                  className={fillBar}
                  title={t("calls.shareTitle", {
                    family: t(`families.${family.group}`),
                    share: formatRatio(family.share, locale),
                  })}
                >
                  <i
                    className={fillBarFill}
                    style={{ width: ratioWidth(family.calls / widest) }}
                  />
                </span>
              </td>
              <td className={numericCell}>
                {formatRatio(family.share, locale)}
              </td>
              <td className={numericCell}>
                {formatDuration(family.ms, locale)}
              </td>
              <td className={numericCell}>
                {family.failed === 0 ? (
                  <span className="text-dim">{formatCount(0, locale)}</span>
                ) : (
                  <Badge tone="denied">
                    {formatCount(family.failed, locale)}
                  </Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PerBatch({ batches, calls }: { batches: Batches; calls: number }) {
  const t = useTranslations("run.cost.calls");
  const locale = useLocale();
  const count = (value: number) => formatCount(value, locale);
  const rows = [...batches.histogram.entries()].sort(([a], [b]) => a - b);
  const widest = Math.max(1, ...rows.map(([, batchCount]) => batchCount));
  const won = Math.max(0, batches.serialMs - batches.togetherMs);
  return (
    <>
      <div className="grid gap-1.5">
        {rows.map(([tools, batchCount]) => (
          <div key={tools} data-testid="batch-row" className={histRow}>
            <span className={histKey}>{t("histKey", { count: tools })}</span>
            <span
              className={fillBar}
              title={t("histTitle", { batches: batchCount, tools })}
            >
              <i
                className={fillBarFill}
                style={{ width: ratioWidth(batchCount / widest) }}
              />
            </span>
            <span className={histValue}>{count(batchCount)}</span>
          </div>
        ))}
      </div>
      <div className="mt-3">
        <Facts>
          <Fact label={t("batches")}>
            {t.rich("batchesValue", {
              count: count(batches.count),
              parallel: () => <b>{count(batches.parallel)}</b>,
            })}
          </Fact>
          <Fact label={t("widest")}>
            {t("widestValue", { count: batches.widest })}
          </Fact>
          <Fact label={t("fanOut")}>
            {t("fanOutValue", { calls, batches: batches.count })}
          </Fact>
          <Fact label={t("won")}>
            {t.rich("wonValue", {
              won: () => <b>{formatDuration(won, locale)}</b>,
              together: formatDuration(batches.togetherMs, locale),
              serial: formatDuration(batches.serialMs, locale),
            })}
          </Fact>
        </Facts>
      </div>
    </>
  );
}

function Prefetch() {
  const t = useTranslations("run.cost.calls");
  return (
    <>
      <div data-testid="prefetch-figure" className={specValue}>
        <NoValue />
      </div>
      <span aria-hidden="true" className={emptyTrack} />
      <div className="mt-3">
        <Facts>
          <Fact label={t("eligible")}>
            <NoValue />
          </Fact>
          <Fact label={t("hitRate")}>
            <NoValue />
          </Fact>
          <Fact label={t("saved")}>
            <NoValue />
          </Fact>
          <Fact label={t("billed")}>
            <NoValue />
          </Fact>
        </Facts>
      </div>
      <div className="mt-[11px]">
        <Note testId="prefetch-note">{t("prefetchNote")}</Note>
      </div>
    </>
  );
}

export function ToolCalls({ metrics }: { metrics: RunMetrics }) {
  const t = useTranslations("run.cost.calls");
  const { toolCalls, families, batches } = metrics;
  return (
    <Panel
      title={t("title")}
      testId="tool-calls"
      flush
      aside={
        toolCalls === null || families === null ? undefined : (
          <span className="font-mono text-[11px] text-dim">
            {t("tally", {
              calls: toolCalls.count,
              // `batches` is null only for a run with no tool call, which ran
              // no batch: the zero is the count, not a stand-in for one.
              batches: batches === null ? 0 : batches.count,
              families: families.length,
            })}
          </span>
        )
      }
    >
      <div className={columns}>
        <div className={wideColumn}>
          <p className={`${eyebrowQuiet} mb-2.5 mt-0`}>{t("byFamily")}</p>
          {toolCalls === null || families === null ? (
            <p className="m-0 text-[12.5px] text-muted-foreground">
              {t("notRead")}
            </p>
          ) : families.length === 0 ? (
            <p className="m-0 text-[12.5px] text-muted-foreground">
              {t("noCalls")}
            </p>
          ) : (
            <FamilyTable families={families} />
          )}
          <p className="mb-0 mt-[9px] text-[11.5px] text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">
            {t.rich("familyNote", { b: (chunks) => <b>{chunks}</b> })}
          </p>
        </div>
        <div className={column}>
          <p className={`${eyebrowQuiet} mb-2.5 mt-0`}>{t("perBatch")}</p>
          {batches === null || toolCalls === null ? (
            <p className="m-0 text-[12.5px] text-muted-foreground">
              {toolCalls === null ? t("notRead") : t("noCalls")}
            </p>
          ) : (
            <PerBatch batches={batches} calls={toolCalls.count} />
          )}
        </div>
        <div className={column}>
          <p className={`${eyebrowQuiet} mb-2.5 mt-0`}>{t("prefetch")}</p>
          <Prefetch />
        </div>
      </div>
    </Panel>
  );
}
