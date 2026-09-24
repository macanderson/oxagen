// The Cost tab (#2962; spec §12.6, §12.7 "Run" row; ADR-060): the run's
// `cost.run_totals` row, with the per-model and per-tool breakdown under it.
//
// The rollup is rebuilt from the frames while the run records them and again
// when it seals (#3980). A rollup built from an open run is an estimate, and
// the tab says so above its figures. Before the first rollup the tab says that
// in words rather than printing zeros: a zero is a figure the rollup measured,
// and "not yet rolled up" is not.
//
// Every money figure carries the basis that says who observed it (INV-10), and
// the price entries the frames were priced with are named, so a figure can be
// traced to the prices that produced it.
//
// Above the rollup sits the waterfall (spec §12.9), which is not read from the
// rollup at all: it is the run's own per-turn ledger, so a turn's cost on this
// tab is the same figure the Transcript tab prints against that turn.
import { useLocale, useTranslations } from "next-intl";
import type {
  RunCost,
  RunCostRollup,
  RunTranscript,
  TokenCounts,
} from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { mono } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { formatCount, formatRatio } from "@/ui/money-format";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { Fact, Facts, NoValue, Panel } from "./parts";
import { Waterfall } from "./waterfall";

const TOKEN_CLASSES = [
  "inputUncached",
  "cacheRead",
  "cacheWrite5m",
  "cacheWrite1h",
  "output",
  "reasoning",
] as const satisfies readonly (keyof TokenCounts)[];

function Tokens({ tokens }: { tokens: TokenCounts }) {
  const t = useTranslations("run.cost");
  const locale = useLocale();
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
      {TOKEN_CLASSES.map((klass) => (
        <li key={klass} className="flex gap-1.5">
          <span className="text-muted-foreground">{t(`tokens.${klass}`)}</span>
          <span className="tabular-nums">
            {formatCount(tokens[klass], locale)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Rollup({ rollup }: { rollup: RunCostRollup }) {
  const t = useTranslations("run.cost");
  const format = useFormatter();
  const locale = useLocale();
  const ratio = (value: number | null) =>
    value === null ? <NoValue /> : formatRatio(value, locale);
  const count = (value: number | null) =>
    value === null ? <NoValue /> : formatCount(value, locale);
  return (
    <div className="flex flex-col gap-5">
      {rollup.isEstimate === true ? (
        <p
          data-testid="cost-estimate"
          className="max-w-prose text-sm text-muted-foreground"
        >
          {t("estimate")}
        </p>
      ) : null}
      <Facts>
        <Fact label={t("total")}>
          {rollup.cost === null ? (
            <NoValue />
          ) : (
            <>
              <Money value={rollup.cost} precision="exact" />
              <span className={`${mono} ml-2 text-xs text-muted-foreground`}>
                {rollup.cost.basis ?? t("basisNotRecorded")}
              </span>
            </>
          )}
        </Fact>
        <Fact label={t("cacheHitRate")}>{ratio(rollup.cacheHitRate)}</Fact>
        <Fact label={t("turns")}>{count(rollup.turns)}</Fact>
        <Fact label={t("steps")}>{count(rollup.steps)}</Fact>
        <Fact label={t("modelCalls")}>{count(rollup.modelCalls)}</Fact>
        <Fact label={t("toolCalls")}>{count(rollup.toolCalls)}</Fact>
        <Fact label={t("retries")}>{count(rollup.retries)}</Fact>
        <Fact label={t("productiveRatio")}>
          {ratio(rollup.productiveRatio)}
        </Fact>
        <Fact label={t("rolledUpAt")}>
          <time dateTime={rollup.rolledUpAt}>
            {format.dateTime(new Date(rollup.rolledUpAt), {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </time>
        </Fact>
        <Fact label={t("priceEntries")} code>
          {rollup.priceEntryIds.length === 0 ? (
            <NoValue />
          ) : (
            rollup.priceEntryIds.join(", ")
          )}
        </Fact>
      </Facts>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t("tokensTitle")}</h4>
        <Tokens tokens={rollup.tokens} />
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t("byModel")}</h4>
        {rollup.byModel.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noModelCalls")}</p>
        ) : (
          <Table
            label={t("byModel")}
            columns={[
              { label: t("columns.model") },
              { label: t("columns.calls"), numeric: true },
              { label: t("columns.cost"), numeric: true },
              { label: t("columns.tokens") },
            ]}
          >
            {rollup.byModel.map((row) => (
              <tr key={row.model} data-testid="cost-model-row">
                <td className={cell}>
                  <span className={`${mono} break-all`}>{row.model}</span>
                  {row.provider === null ? null : (
                    <span className="block text-xs text-muted-foreground">
                      {row.provider}
                    </span>
                  )}
                </td>
                <td className={numericCell}>
                  {formatCount(row.calls, locale)}
                </td>
                <td className={numericCell}>
                  {row.cost === null ? (
                    <NoValue />
                  ) : (
                    <Money value={row.cost} precision="exact" />
                  )}
                </td>
                <td className={cell}>
                  <Tokens tokens={row.tokens} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t("byTool")}</h4>
        {rollup.byTool.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noToolCalls")}</p>
        ) : (
          <Table
            label={t("byTool")}
            columns={[
              { label: t("columns.tool") },
              { label: t("columns.calls"), numeric: true },
            ]}
          >
            {rollup.byTool.map((row) => (
              <tr key={row.name} data-testid="cost-tool-row">
                <td className={`${cell} ${mono} break-all`}>{row.name}</td>
                <td className={numericCell}>
                  {formatCount(row.calls, locale)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </div>
  );
}

export function CostSection({
  read,
  turns,
  steps,
}: {
  read: Read<RunCost>;
  /** The transcript at the `turns` zoom: the waterfall's bars. */
  turns: Read<RunTranscript>;
  /** The transcript at the `steps` zoom: what sits inside each bar. */
  steps: Read<RunTranscript>;
}) {
  const t = useTranslations("run.cost");
  const waterfall = useTranslations("run.waterfall");
  return (
    <div className="flex flex-col gap-4">
      <Panel title={waterfall("title")}>
        <Waterfall turns={turns} steps={steps} />
      </Panel>
      <Panel title={t("title")}>
        {!read.ok ? (
          <ReadFailure read={read} section={t("title")} />
        ) : read.value.rollup === null ? (
          <p
            data-testid="cost-not-rolled-up"
            className="max-w-prose text-sm text-muted-foreground"
          >
            {t("notRolledUp")}
          </p>
        ) : (
          <Rollup rollup={read.value.rollup} />
        )}
      </Panel>
    </div>
  );
}
