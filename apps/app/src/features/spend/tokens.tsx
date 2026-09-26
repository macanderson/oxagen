// Spend › Tokens (spec "Tokens"): where the month's tokens went. By token
// class sums the month's model rows once (another level would count the same
// calls again), so its total is the Tokens tile. Prompt composition and By
// harness read fields the rollup does not record yet (#2962), so they name
// what is missing. By agent is the agent rollup's twelve largest rows; the
// three prompt-part columns are not recorded, and a row opens the agent page.
import { useLocale, useTranslations } from "next-intl";
import type { SpendReport } from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { formatCount, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { BasisLabel, NotRecordedValue } from "./figures";
import { NotBacked, NotBackedPanel } from "./not-backed";
import {
  cacheHitRate,
  cacheWriteShare,
  classesOf,
  perRun,
  reasoningShare,
  sumClasses,
  TOKEN_CLASSES,
  totalOf,
} from "./rollup";
import { Panel } from "./tables";
import type { SpendAt } from "./view";

/** The prompt parts the design meters, in its order. */
const PROMPT_PARTS = [
  "conversation",
  "toolResults",
  "contextFrames",
  "toolDefinitions",
  "steering",
  "system",
  "output",
  "reasoning",
] as const;

/** How many agents the By agent panel lists. */
const AGENTS_LISTED = 12;

function Ratio({ value }: { value: number | null }) {
  const locale = useLocale();
  return value === null ? (
    <NotRecordedValue />
  ) : (
    <>{formatRatio(value, locale)}</>
  );
}

export function TokensSection({
  month,
  agents,
  at,
}: {
  month: SpendReport;
  agents: Read<SpendReport>;
  at: SpendAt;
}) {
  const t = useTranslations("spend.tokens");
  const locale = useLocale();
  const classes = sumClasses(month.rows);
  const total = totalOf(classes);
  return (
    <>
      <div className="grid gap-3.5 lg:grid-cols-2">
        <Panel
          id="spend-token-classes"
          title={t("byClass")}
          action={
            <span className={`${mono} text-[11px] text-muted-foreground`}>
              {t("classTotal", {
                tokens: formatCount(total, locale),
                from: month.period.from,
                to: month.period.to,
              })}
            </span>
          }
          footer={
            <dl className="grid w-full grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
              <dt>{t("cacheHit")}</dt>
              <dd className="text-foreground">
                <Ratio value={cacheHitRate(classes)} /> {t("cacheHitNote")}
              </dd>
              <dt>{t("cacheWritten")}</dt>
              <dd className="text-foreground">
                <Ratio value={cacheWriteShare(classes)} />{" "}
                {t("cacheWrittenNote")}
              </dd>
              <dt>{t("cacheWriteShare")}</dt>
              <dd>
                <NotBacked gap="rollup">{t("costByClassMissing")}</NotBacked>
              </dd>
              <dt>{t("effectiveInput")}</dt>
              <dd>
                <NotBacked gap="rollup">{t("costByClassMissing")}</NotBacked>
              </dd>
              <dt>{t("unmapped")}</dt>
              <dd>
                <NotBacked gap="rollup">{t("unmappedMissing")}</NotBacked>
              </dd>
            </dl>
          }
        >
          <Table
            label={t("byClass")}
            columns={[
              { label: t("columns.class") },
              { label: t("columns.tokens"), numeric: true },
              { label: t("columns.share"), numeric: true },
              { label: t("columns.cost"), numeric: true },
            ]}
          >
            {TOKEN_CLASSES.map((key) => (
              <tr key={key} data-token-class={key}>
                <th
                  scope="row"
                  className={`${cell} text-left font-mono font-normal`}
                >
                  {key}
                </th>
                <td className={numericCell}>
                  {formatCount(classes[key], locale)}
                </td>
                <td className={numericCell}>
                  <Ratio value={total === 0 ? null : classes[key] / total} />
                </td>
                <td className={numericCell}>
                  <NotRecordedValue />
                </td>
              </tr>
            ))}
          </Table>
        </Panel>
        <NotBackedPanel
          id="spend-prompt-composition"
          title={t("composition")}
          gap="rollup"
        >
          {t("compositionMissing")}
          <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {PROMPT_PARTS.map((part) => (
              <span key={part} data-prompt-part={part}>
                {t(`parts.${part}`)}
              </span>
            ))}
          </span>
        </NotBackedPanel>
      </div>
      <NotBackedPanel id="spend-by-harness" title={t("byHarness")} gap="rollup">
        {t("harnessMissing")}
      </NotBackedPanel>
      <Panel
        id="spend-tokens-agent"
        title={t("byAgent")}
        footer={t("agentNote")}
      >
        {agents.ok ? (
          <Table
            label={t("byAgent")}
            columns={[
              { label: t("columns.agent") },
              { label: t("columns.runs"), numeric: true },
              { label: t("columns.tokens"), numeric: true },
              { label: t("columns.perRun"), numeric: true },
              { label: t("columns.cacheHit"), numeric: true },
              { label: t("columns.toolDefs"), numeric: true },
              { label: t("columns.context"), numeric: true },
              { label: t("columns.toolResults"), numeric: true },
              { label: t("columns.reasoning"), numeric: true },
              { label: t("columns.basis") },
            ]}
          >
            {[...agents.value.rows]
              .map((row) => ({ row, classes: classesOf(row.tokens) }))
              .sort((a, b) => totalOf(b.classes) - totalOf(a.classes))
              .slice(0, AGENTS_LISTED)
              .map(({ row, classes: own }) => {
                const tokens = totalOf(own);
                const per = perRun(tokens, row.runs);
                return (
                  <tr key={row.key} data-key={row.key}>
                    <th scope="row" className={`${cell} text-left font-normal`}>
                      <SafeLink
                        to={routes.agent(
                          at.org,
                          at.ws,
                          row.key.split(".").pop() ?? row.key,
                        )}
                        className={`${linkText} ${mono} break-all`}
                      >
                        {row.key}
                      </SafeLink>
                    </th>
                    <td className={numericCell}>
                      {formatCount(row.runs, locale)}
                    </td>
                    <td className={numericCell}>
                      {formatCount(tokens, locale)}
                    </td>
                    <td className={numericCell}>
                      {per === null ? (
                        <NotRecordedValue />
                      ) : (
                        formatCount(per, locale)
                      )}
                    </td>
                    <td className={numericCell}>
                      <Ratio value={cacheHitRate(own)} />
                    </td>
                    <td className={numericCell}>
                      <NotRecordedValue />
                    </td>
                    <td className={numericCell}>
                      <NotRecordedValue />
                    </td>
                    <td className={numericCell}>
                      <NotRecordedValue />
                    </td>
                    <td className={numericCell}>
                      <Ratio value={reasoningShare(own)} />
                    </td>
                    <td className={cell}>
                      <BasisLabel basis={row.cost?.basis ?? null} />
                    </td>
                  </tr>
                );
              })}
          </Table>
        ) : (
          <div className="px-4 py-3.5">
            <ReadFailure read={agents} section={t("byAgent")} />
          </div>
        )}
      </Panel>
    </>
  );
}
