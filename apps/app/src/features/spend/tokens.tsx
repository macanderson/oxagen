// Spend › Tokens (spec "Tokens"): where the month's tokens went. By token
// class sums the month's model rows once (another level would count the same
// calls again), so its total is the Tokens tile. Prompt composition reads
// get_spend's composition for the standing context and the tool results, and
// the classes for output and reasoning, each as a share of that total; the
// conversation and the system prompt are not recorded (#5293). By harness
// reads a field the rollup does not record yet (#2962), so it names what is
// missing. By agent is the agent rollup's twelve largest rows; the three
// prompt-part columns are not recorded, and a row opens the agent page. Each
// agent's avatar carries the harness it registered (#4871).
import { useLocale, useTranslations } from "next-intl";
import { ASSISTANT_SPEND_KEY, type SpendReport } from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { formatCount, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { type AgentHarnesses, AgentMark, harnessIn } from "./agent-mark";
import { BasisLabel, NotRecordedValue } from "./figures";
import { NotBacked, NotBackedPanel } from "./not-backed";
import {
  cacheHitRate,
  cacheWriteShare,
  classesOf,
  perRun,
  reasoningShare,
  searchRequestsOf,
  sumClasses,
  TOKEN_CLASSES,
  type TokenClasses,
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

type PromptPart = (typeof PROMPT_PARTS)[number];

/**
 * A prompt part's tokens over the month: the standing context and the tool
 * results from get_spend's composition, and output and reasoning from the
 * token classes. Null for a part nothing records: the conversation and the
 * system prompt, and a part no run measured.
 */
function partTokens(
  part: PromptPart,
  composition: SpendReport["composition"],
  classes: TokenClasses,
): number | null {
  switch (part) {
    case "toolResults":
      return composition?.toolResultTokens ?? null;
    case "contextFrames":
      return composition?.contextFrameTokens ?? null;
    case "toolDefinitions":
      return composition?.toolDefinitionTokens ?? null;
    case "steering":
      return composition?.steeringTokens ?? null;
    case "output":
      return classes.output;
    case "reasoning":
      return classes.reasoning;
    case "conversation":
    case "system":
      return null;
  }
}

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
  harnesses = {},
}: {
  month: SpendReport;
  agents: Read<SpendReport>;
  at: SpendAt;
  /** Each agent's registered harness, by key, for the avatars' badges. */
  harnesses?: AgentHarnesses;
}) {
  const t = useTranslations("spend.tokens");
  const tMonth = useTranslations("spend.month");
  const locale = useLocale();
  const classes = sumClasses(month.rows);
  const total = totalOf(classes);
  const searches = searchRequestsOf(month.rows);
  return (
    <>
      <div className="grid gap-3.5 lg:grid-cols-2">
        <Panel
          id="spend-token-classes"
          title={t("byClass")}
          action={
            <span className={`${mono} text-xs text-muted-foreground`}>
              {t("classTotal", {
                tokens: formatCount(total, locale),
                from: month.period.from,
                to: month.period.to,
              })}
            </span>
          }
          footer={
            <dl className="grid w-full grid-cols-dl-max gap-x-4 gap-y-1.5 text-sm">
              <dt>{t("cacheHit")}</dt>
              <dd className="text-foreground">
                <Ratio value={cacheHitRate(classes)} /> {t("cacheHitNote")}
              </dd>
              <dt>{t("cacheWritten")}</dt>
              <dd className="text-foreground">
                <Ratio value={cacheWriteShare(classes)} />{" "}
                {t("cacheWrittenNote")}
              </dd>
              <dt>{t("searches")}</dt>
              <dd className="text-foreground" data-testid="spend-searches">
                {t("searchesNote", {
                  count: searches,
                })}
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
        <Panel
          id="spend-prompt-composition"
          title={t("composition")}
          footer={t("compositionFooter")}
        >
          <Table
            label={t("composition")}
            columns={[
              { label: t("columns.part") },
              { label: t("columns.tokens"), numeric: true },
              { label: t("columns.share"), numeric: true },
            ]}
          >
            {PROMPT_PARTS.map((part) => {
              const tokens = partTokens(part, month.composition, classes);
              return (
                <tr key={part} data-prompt-part={part}>
                  <th scope="row" className={`${cell} text-left font-normal`}>
                    {t(`parts.${part}`)}
                  </th>
                  <td className={numericCell}>
                    {tokens === null ? (
                      <NotRecordedValue />
                    ) : (
                      formatCount(tokens, locale)
                    )}
                  </td>
                  <td className={numericCell}>
                    <Ratio
                      value={
                        tokens === null || total === 0 ? null : tokens / total
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </Table>
        </Panel>
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
                      {/* The in-app assistant is no agent of the workspace's,
                          so its row links nowhere (ADR-235). */}
                      {row.key === ASSISTANT_SPEND_KEY ? (
                        <span>{tMonth("assistant.label")}</span>
                      ) : (
                        <span className="flex min-w-0 items-center gap-2">
                          <AgentMark
                            agentKey={row.key}
                            harness={harnessIn(harnesses, row.key)}
                          />
                          <SafeLink
                            to={routes.agent(
                              at.org,
                              at.ws,
                              row.key.split(".").pop() ?? row.key,
                            )}
                            className={`${linkText} ${mono}`}
                          >
                            {row.key}
                          </SafeLink>
                        </span>
                      )}
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
