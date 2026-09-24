// The Budgets section of an agent's page (#2953): the spend ceilings the agent
// runs under, read-only, with the basis of every figure and a link to the page
// that sets them.
//
// This panel writes nothing, and that is the whole shape of it.
// `get_spend_budget`'s `spendScope` is `org | workspace` and nothing narrower
// (packages/oxagen/src/contracts/billing.budget.get.ts), so there is no
// per-agent ceiling to read and none to set. A panel with a Set budget control
// on it would claim a bound Oxagen does not record and would not enforce, so
// the tab shows the ceilings that do govern this agent, says plainly that no
// per-agent one exists, and sends the write to Spend, where the contract's
// scopes live. Agent-scope budgets wait on an ADR for the scopes
// `billing.budgets` accepts (oxagen-roadmap:docs/oxagen/mission-control/BUILD-CHUNKS.md).
//
// The read is `source.spend.budgets`, not a port method of its own: it is the
// same record the Spend page's Budgets tab reads, and reading it under the
// spend page key is what makes a refusal name `spend.read`, the permission
// that is actually missing, rather than `agent.read`.
import { useLocale, useTranslations } from "next-intl";
import type { SpendBudgets } from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import type { SafePath } from "@/shared/safe-path";
import { linkText } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, Table } from "@/ui/table";
import { NotRecordedValue, Panel } from "./parts";

function Ceilings({ budgets }: { budgets: SpendBudgets }) {
  const t = useTranslations("agents.detail.budgets");
  const locale = useLocale();
  return (
    <Table
      label={t("title")}
      columns={[
        { label: t("columns.scope") },
        { label: t("columns.period") },
        { label: t("columns.limit") },
        { label: t("columns.spent") },
        { label: t("columns.position") },
      ]}
    >
      {budgets.map((budget) => (
        <tr key={budget.scope} data-scope={budget.scope}>
          <th scope="row" className={`${cell} text-left font-normal`}>
            {t(`scope.${budget.scope}`)}
          </th>
          <td className={cell}>
            {budget.period === "monthly" ? (
              t("monthly")
            ) : budget.windowDays === null ? (
              <NotRecordedValue />
            ) : (
              t("rolling", { days: formatCount(budget.windowDays, locale) })
            )}
          </td>
          <td className={cell}>
            {budget.limit === null ? (
              t("noLimit")
            ) : (
              <Money value={budget.limit} />
            )}
          </td>
          <td className={cell}>
            <Money value={budget.spent} />
          </td>
          {/*
            A ceiling that is not enforced says so rather than printing a
            percentage, because the percentage would read as a bound that is
            holding. A disabled ceiling is a documented no-op.
          */}
          <td className={cell} data-state={budget.state}>
            {!budget.enabled
              ? t("disabled")
              : budget.limit === null
                ? t("noLimit")
                : t("position", {
                    ratio: formatRatio(budget.ratio, locale),
                    state: t(`state.${budget.state}`),
                  })}
          </td>
        </tr>
      ))}
    </Table>
  );
}

export function BudgetSection({
  read,
  spend,
}: {
  read: Read<SpendBudgets>;
  /** Spend on its Budgets tab, where a ceiling is set. */
  spend: SafePath;
}) {
  const t = useTranslations("agents.detail.budgets");
  return (
    <Panel id="agent-budgets" title={t("title")} lead={t("lead")}>
      {!read.ok ? (
        <ReadFailure read={read} section={t("title")} />
      ) : read.value.length === 0 ? (
        <p data-testid="budgets-empty" className="text-sm">
          {t("empty")}
        </p>
      ) : (
        <>
          <Ceilings budgets={read.value} />
          <p className="max-w-prose text-xs text-muted-foreground">
            {t("basis")}
          </p>
        </>
      )}
      {/*
        The one thing this page cannot show. It is not a NotRecorded row from
        src/data/unrecorded.ts: that table is for a whole page with no store
        behind it, and this is a slice of a page whose store answers.
      */}
      <p
        data-testid="agent-budget-not-backed"
        className="max-w-prose text-sm text-muted-foreground"
      >
        {t("agentScope")}
      </p>
      <SafeLink to={spend} className={`${linkText} self-start text-sm`}>
        {t("link")}
      </SafeLink>
    </Panel>
  );
}
