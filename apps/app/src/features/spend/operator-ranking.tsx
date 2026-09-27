// Spend › By operator › Operator ranking (D15, #2962; spec "Operator
// ranking"): the workspace's operators by unproductive spend for the period,
// highest first, from get_operator_ranking. An org Owner or Admin, or the
// workspace's Owner, reads it, and anyone else sees who can. Only an org
// Owner or Admin sees the pseudonym switch. Each figure links to its
// definition under the table, and each operator's runs link to their Cost
// tab. The panel reports the record and gives no verdict on the person. The
// operator rows and the row for runs with no operator sum to the total row.
// With the workspace's pseudonyms on, a stable pseudonym replaces each name,
// and the share, the run count and the runs are hidden: each could match a
// pseudonym to a named row on the By operator table below.
import { useLocale, useTranslations } from "next-intl";
import { ratioOfMicros } from "@/data/contracts/money";
import type {
  OperatorRanking,
  OperatorRankingRow,
} from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { linkText } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { OperatorName } from "@/ui/operator";
import { cell, numericCell, Table } from "@/ui/table";
import { NotRecordedValue } from "./figures";
import { OperatorPseudonymsToggle } from "./operator-ranking-pseudonyms";
import { SpendSectionFailure } from "./states";
import { Empty, Panel } from "./tables";
import type { SpendAt } from "./view";

/** The handler's refusal for a period whose claims hold two currencies. */
const MIXED_CURRENCY = "ranking_mixed_currency";

/**
 * Who reads the ranking: an org Owner or Admin, or the workspace's Owner, the
 * roles get_operator_ranking's defaultRoles allow and its handler asserts. The
 * page asks for every role the kernel grants, so it never gates narrower than
 * the check it guards (`WsCtx.wsRole`, #3143). Until a person can hold a
 * workspace IAM role (#3198), the handler refuses a workspace Owner who is an
 * org Member, and the section shows that refusal as its denied state.
 */
export function canReadOperatorRanking(
  ctx: Pick<WsCtx, "orgRole" | "wsRole">,
): boolean {
  return (
    ctx.orgRole === "owner" || ctx.orgRole === "admin" || ctx.wsRole === "owner"
  );
}

/**
 * Who sets the pseudonyms: an org Owner or Admin, the narrower pair
 * set_operator_pseudonyms asserts. A workspace Owner reads the ranking but
 * does not see the switch.
 */
export function canSetOperatorPseudonyms(
  ctx: Pick<WsCtx, "orgRole">,
): boolean {
  return ctx.orgRole === "owner" || ctx.orgRole === "admin";
}

/**
 * `ranking` is null when the viewer is not a manager: the page does not ask,
 * and the panel says who can read it.
 */
export function OperatorRankingSection({
  ranking,
  at,
  canSetPseudonyms,
}: {
  ranking: Read<OperatorRanking> | null;
  at: SpendAt;
  /** Whether the viewer may change the pseudonym setting. */
  canSetPseudonyms: boolean;
}) {
  const t = useTranslations("spend.ranking");
  if (ranking === null) {
    return (
      <Panel id="spend-ranking" title={t("title")}>
        <Empty>{t("managersOnly")}</Empty>
      </Panel>
    );
  }
  if (!ranking.ok) {
    if (ranking.reason === "error" && ranking.code === MIXED_CURRENCY) {
      return (
        <Panel id="spend-ranking" title={t("title")}>
          <Empty>{t("mixedCurrency")}</Empty>
        </Panel>
      );
    }
    return <SpendSectionFailure read={ranking} />;
  }
  return (
    <RankingPanel
      ranking={ranking.value}
      at={at}
      canSetPseudonyms={canSetPseudonyms}
    />
  );
}

function RankingPanel({
  ranking,
  at,
  canSetPseudonyms,
}: {
  ranking: OperatorRanking;
  at: SpendAt;
  canSetPseudonyms: boolean;
}) {
  const t = useTranslations("spend.ranking");
  const locale = useLocale();
  const hidden = ranking.pseudonyms;
  const unattributedShare = ratioOfMicros(
    ranking.unattributed.unproductive,
    ranking.unproductive,
  );
  return (
    <Panel
      id="spend-ranking"
      title={t("title")}
      note={t("note")}
      action={
        canSetPseudonyms ? (
          <OperatorPseudonymsToggle at={at} pseudonyms={ranking.pseudonyms} />
        ) : undefined
      }
      footer={<Definitions hidden={hidden} />}
    >
      {ranking.operators.length === 0 && ranking.unattributed.runs === 0 ? (
        <Empty>{t("empty")}</Empty>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("columns.rank"), numeric: true },
            { label: t("columns.operator") },
            { label: t("columns.unproductive"), numeric: true },
            { label: t("columns.shareOfTotal"), numeric: true },
            { label: t("columns.unproductiveShare"), numeric: true },
            { label: t("columns.runs"), numeric: true },
            { label: t("columns.runsBehind") },
          ]}
        >
          {ranking.operators.map((row) => (
            <RankingRow key={row.rank} row={row} hidden={hidden} at={at} />
          ))}
          <tr data-row="unattributed">
            <td className={numericCell} />
            <th scope="row" className={`${cell} text-left font-normal`}>
              {t("unattributed")}
            </th>
            <td className={numericCell}>
              <a
                href="#spend-ranking-def-unproductive"
                aria-describedby="spend-ranking-def-unproductive"
                className={linkText}
              >
                <Money value={ranking.unattributed.unproductive} />
              </a>
            </td>
            <td className={numericCell}>
              {unattributedShare === null ? (
                <NotRecordedValue />
              ) : (
                <a
                  href="#spend-ranking-def-shareOfTotal"
                  aria-describedby="spend-ranking-def-shareOfTotal"
                  className={linkText}
                >
                  {formatRatio(unattributedShare, locale)}
                </a>
              )}
            </td>
            <td className={numericCell} />
            <td className={numericCell}>
              <a
                href="#spend-ranking-def-runs"
                aria-describedby="spend-ranking-def-runs"
                className={linkText}
              >
                {formatCount(ranking.unattributed.runs, locale)}
              </a>
            </td>
            <td className={cell} />
          </tr>
          <tr data-row="total" className="border-t border-border">
            <td className={numericCell} />
            <th scope="row" className={`${cell} text-left font-semibold`}>
              {t("total")}
            </th>
            <td className={`${numericCell} font-semibold`}>
              <a
                href="#spend-ranking-def-unproductive"
                aria-describedby="spend-ranking-def-unproductive"
                className={linkText}
              >
                <Money value={ranking.unproductive} />
              </a>
            </td>
            <td className={numericCell} />
            <td className={numericCell} />
            <td className={numericCell} />
            <td className={cell} />
          </tr>
        </Table>
      )}
    </Panel>
  );
}

function RankingRow({
  row,
  hidden,
  at,
}: {
  row: OperatorRankingRow;
  hidden: boolean;
  at: SpendAt;
}) {
  const t = useTranslations("spend.ranking");
  const locale = useLocale();
  return (
    <tr data-rank={row.rank}>
      <td className={numericCell}>{formatCount(row.rank, locale)}</td>
      <th scope="row" className={`${cell} text-left font-semibold`}>
        <Operator row={row} at={at} />
      </th>
      <td className={numericCell}>
        {/* Each fragment is written out: a link's target is never computed (INV-13). */}
        <a
          href="#spend-ranking-def-unproductive"
          aria-describedby="spend-ranking-def-unproductive"
          className={linkText}
        >
          <Money value={row.unproductive} />
        </a>
      </td>
      <td className={numericCell}>
        <a
          href="#spend-ranking-def-shareOfTotal"
          aria-describedby="spend-ranking-def-shareOfTotal"
          className={linkText}
        >
          {formatRatio(row.shareOfTotal, locale)}
        </a>
      </td>
      <td className={numericCell}>
        {hidden ? (
          <Hidden />
        ) : row.unproductiveShare === null ? (
          <NotRecordedValue />
        ) : (
          <a
            href="#spend-ranking-def-unproductiveShare"
            aria-describedby="spend-ranking-def-unproductiveShare"
            className={linkText}
          >
            {formatRatio(row.unproductiveShare, locale)}
          </a>
        )}
      </td>
      <td className={numericCell}>
        {hidden || row.runs === null ? (
          <Hidden />
        ) : (
          <a
            href="#spend-ranking-def-runs"
            aria-describedby="spend-ranking-def-runs"
            className={linkText}
          >
            {formatCount(row.runs, locale)}
          </a>
        )}
      </td>
      <td className={cell}>
        {hidden ? (
          <Hidden />
        ) : row.topRuns.length === 0 ? (
          <NotRecordedValue />
        ) : (
          <details>
            <summary className={`${linkText} cursor-pointer`}>
              {t("runsBehind", { count: row.topRuns.length })}
            </summary>
            <ul className="mt-1 flex flex-col gap-1">
              {row.topRuns.map((run) => (
                <li
                  key={run.runId}
                  className="flex items-baseline justify-between gap-3"
                >
                  <SafeLink
                    to={routes.run(at.org, at.ws, run.runId, { tab: "cost" })}
                    className={`${linkText} font-mono text-[11.5px]`}
                  >
                    {run.runId}
                  </SafeLink>
                  <Money value={run.unproductive} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </td>
    </tr>
  );
}

/** The person by name with a link to their drill, or the pseudonym alone. */
function Operator({ row, at }: { row: OperatorRankingRow; at: SpendAt }) {
  const t = useTranslations("spend.ranking");
  const who = row.operator;
  if (who.kind === "pseudonym") {
    return <span data-pseudonym="true">{who.pseudonym}</span>;
  }
  return (
    <OperatorName
      operator={{
        id: who.key,
        name: who.facts?.name ?? null,
        kind: "human",
        email: who.facts?.email ?? null,
        avatarUrl: who.facts?.avatarUrl ?? null,
        role: who.facts?.role ?? null,
      }}
    >
      <SafeLink
        to={routes.spend(at.org, at.ws, { tab: "operator", drill: who.key })}
        className={linkText}
      >
        {who.facts?.name ?? t("unnamed")}
      </SafeLink>
    </OperatorName>
  );
}

function Hidden() {
  const t = useTranslations("spend.ranking");
  return (
    <span data-hidden="true" className="text-muted-foreground">
      {t("hidden")}
    </span>
  );
}

/** What each figure counts. Every figure in the table links here by its id. */
function Definitions({ hidden }: { hidden: boolean }) {
  const t = useTranslations("spend.ranking");
  return (
    <div className="flex flex-col gap-2">
      {hidden ? <p>{t("hiddenNote")}</p> : null}
      <h3 className="font-medium text-foreground">{t("definitionsTitle")}</h3>
      <dl className="grid gap-1.5 sm:grid-cols-[max-content_1fr] sm:gap-x-4">
        <dt className="font-medium text-foreground">
          {t("columns.unproductive")}
        </dt>
        <dd id="spend-ranking-def-unproductive">
          {t("definitions.unproductive")}
        </dd>
        <dt className="font-medium text-foreground">
          {t("columns.shareOfTotal")}
        </dt>
        <dd id="spend-ranking-def-shareOfTotal">
          {t("definitions.shareOfTotal")}
        </dd>
        <dt className="font-medium text-foreground">
          {t("columns.unproductiveShare")}
        </dt>
        <dd id="spend-ranking-def-unproductiveShare">
          {t("definitions.unproductiveShare")}
        </dd>
        <dt className="font-medium text-foreground">{t("columns.runs")}</dt>
        <dd id="spend-ranking-def-runs">{t("definitions.runs")}</dd>
      </dl>
    </div>
  );
}
