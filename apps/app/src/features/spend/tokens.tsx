import { useLocale, useTranslations } from "next-intl";
import type { SpendReport } from "@/data/contracts/spend";
import { formatCount, formatRatio } from "@/ui/money-format";
import { cell, Table } from "@/ui/table";
import { CostFigure, NotRecordedValue } from "./figures";
import { Panel } from "./tables";

/** Sum the model groups once; another grouping would count the same calls again. */
export function tokenClasses(report: SpendReport) {
  const totals = {
    input_uncached: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
    reasoning: 0,
  };
  for (const { tokens } of report.rows) {
    totals.input_uncached += tokens.input_uncached;
    totals.cache_read += tokens.cache_read;
    totals.cache_write += tokens.cache_write_5m + tokens.cache_write_1h;
    totals.output += tokens.output;
    totals.reasoning += tokens.reasoning;
  }
  return totals;
}

export function TokensSection({ report }: { report: SpendReport }) {
  const t = useTranslations("spend.tokens");
  const locale = useLocale();
  const classes = tokenClasses(report);
  const total = Object.values(classes).reduce((sum, value) => sum + value, 0);
  const input = classes.input_uncached + classes.cache_read;
  return (
    <>
      <Panel
        id="spend-token-classes"
        title={t("title")}
        note={t("note")}
        footer={
          <span>
            {t("cacheHit")}:{" "}
            {input === 0 ? (
              <NotRecordedValue />
            ) : (
              formatRatio(classes.cache_read / input, locale)
            )}
            . {t("cacheNote")}
          </span>
        }
      >
        <Table
          label={t("title")}
          columns={[
            { label: t("class") },
            { label: t("count") },
            { label: t("share") },
          ]}
        >
          {(Object.keys(classes) as (keyof typeof classes)[]).map((key) => (
            <tr key={key} data-token-class={key}>
              <th scope="row" className={cell}>
                {t(key)}
              </th>
              <td className={cell}>{formatCount(classes[key], locale)}</td>
              <td className={cell}>
                {total === 0 ? (
                  <NotRecordedValue />
                ) : (
                  formatRatio(classes[key] / total, locale)
                )}
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row" className={cell}>
              {t("total")}
            </th>
            <td className={cell}>{formatCount(total, locale)}</td>
            <td className={cell} />
          </tr>
        </Table>
      </Panel>
      <Panel id="spend-tokens-model" title={t("byModel")}>
        <Table
          label={t("byModel")}
          columns={[
            { label: t("model") },
            { label: t("count") },
            { label: t("basis") },
          ]}
        >
          {report.rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className={`${cell} break-all font-mono`}>
                {row.key}
              </th>
              <td className={cell}>
                {formatCount(
                  Object.values(row.tokens).reduce(
                    (sum, count) => sum + count,
                    0,
                  ),
                  locale,
                )}
              </td>
              <td className={cell}>
                <CostFigure cost={row.cost} />
              </td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}
