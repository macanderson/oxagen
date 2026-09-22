// The Spend page body (#2962, #2963; ARCHITECTURE.md §1.2): the open costed
// findings the page leads with and one finding's evidence, the cost rollup for
// the current month by operator, agent (with the models beside it) and tool,
// wasted spend by cause, the configured ceilings, one key's drill, and the
// price book with the models it cannot price. Every
// read is a noBillingGate kernel read through the spend port; the first read
// that does not answer replaces the body with its state. Beside the tabs, Export
// report and Set a budget open their dialogs on every view.
import "server-only";
import type { ReactNode } from "react";
import type { SpendReport } from "@/data/contracts/spend";
import type { DataSource } from "@/data/ports";
import { PageRecord } from "@/features/shell";
import type { WsCtx } from "@/server/viewer";
import { BudgetDialog } from "./budget-dialog";
import { DrillSection } from "./drill";
import { ExportDialog } from "./export-dialog";
import { SpendStrip } from "./figures";
import { GatewayPolicySection } from "./gateway-policy";
import { FindingEvidenceSection, FindingsSection } from "./findings";
import { PricingSection } from "./pricing";
import { SpendReadFailure, SpendEmpty } from "./states";
import { BudgetsTable, GroupTable } from "./tables";
import { SpendTabs } from "./tabs";
import { WasteSection } from "./waste";
import {
  monthToDate,
  parseSpendView,
  type SpendAt,
  type SpendView,
} from "./view";

type SpendProps = {
  ctx: WsCtx;
  source: DataSource;
  searchParams: Readonly<Record<string, string | string[] | undefined>>;
  /** Today in UTC, the day the month to date is read up to; the clock when absent. */
  today?: Date;
};

export async function Spend({ ctx, source, searchParams, today }: SpendProps) {
  const view = parseSpendView(searchParams);
  const at: SpendAt = { org: ctx.orgSlug, ws: ctx.wsSlug };
  return (
    <div className="flex flex-col gap-4">
      {/* The record this page is actually showing, which is not what the query
          string says on its own: a `finding` outside the Findings tab, or a
          `drill` on a tab that fell back, is not selected here. */}
      <PageRecord route="spend" id={view.finding ?? view.drill} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SpendTabs at={at} current={view.tab} />
        <div className="flex flex-wrap gap-2">
          <ExportDialog at={at} month={monthToDate(today).from.slice(0, 7)} />
          <BudgetDialog at={at} />
        </div>
      </div>
      {await body(ctx, source, view, at, today)}
    </div>
  );
}

function isEmpty(report: SpendReport): boolean {
  return report.total.runs === 0 && report.rows.length === 0;
}

async function body(
  ctx: WsCtx,
  source: DataSource,
  view: SpendView,
  at: SpendAt,
  today: Date | undefined,
): Promise<ReactNode> {
  if (view.drill !== null) {
    const drill = await source.spend.drill(ctx, view.tab, view.drill);
    return drill.ok ? (
      <DrillSection drill={drill.value} at={at} />
    ) : (
      <SpendReadFailure read={drill} />
    );
  }
  const period = monthToDate(today);
  switch (view.tab) {
    case "findings": {
      if (view.finding !== null) {
        const evidence = await source.spend.findingEvidence(ctx, view.finding);
        return evidence.ok ? (
          <FindingEvidenceSection evidence={evidence.value} at={at} />
        ) : (
          <SpendReadFailure read={evidence} />
        );
      }
      const [report, findings] = await Promise.all([
        source.spend.byGroup(ctx, "operator", period),
        source.spend.findings(ctx),
      ]);
      if (!report.ok) return <SpendReadFailure read={report} />;
      if (!findings.ok) return <SpendReadFailure read={findings} />;
      return (
        <>
          <SpendStrip total={report.value.total} period={period} />
          <FindingsSection findings={findings.value} at={at} />
        </>
      );
    }
    case "operator":
    case "tool": {
      const report = await source.spend.byGroup(ctx, view.tab, period);
      if (!report.ok) return <SpendReadFailure read={report} />;
      return (
        <>
          <SpendStrip total={report.value.total} period={period} />
          {isEmpty(report.value) ? (
            <SpendEmpty at={at} />
          ) : (
            <GroupTable kind={view.tab} rows={report.value.rows} at={at} />
          )}
        </>
      );
    }
    case "agent": {
      const [agents, models] = await Promise.all([
        source.spend.byGroup(ctx, "agent", period),
        source.spend.byGroup(ctx, "model", period),
      ]);
      if (!agents.ok) return <SpendReadFailure read={agents} />;
      if (!models.ok) return <SpendReadFailure read={models} />;
      return (
        <>
          <SpendStrip total={agents.value.total} period={period} />
          {isEmpty(agents.value) ? (
            <SpendEmpty at={at} />
          ) : (
            <>
              <GroupTable kind="agent" rows={agents.value.rows} at={at} />
              <GroupTable kind="model" rows={models.value.rows} at={at} />
            </>
          )}
        </>
      );
    }
    case "waste": {
      const [report, waste] = await Promise.all([
        source.spend.byGroup(ctx, "operator", period),
        source.spend.waste(ctx, period),
      ]);
      if (!report.ok) return <SpendReadFailure read={report} />;
      if (!waste.ok) return <SpendReadFailure read={waste} />;
      return (
        <>
          <SpendStrip total={report.value.total} period={period} />
          <WasteSection waste={waste.value} at={at} />
        </>
      );
    }
    case "budgets": {
      const [report, budgets, gateway] = await Promise.all([
        source.spend.byGroup(ctx, "operator", period),
        source.spend.budgets(ctx),
        source.spend.gatewayPolicy(ctx),
      ]);
      if (!report.ok) return <SpendReadFailure read={report} />;
      if (!budgets.ok) return <SpendReadFailure read={budgets} />;
      return (
        <>
          <SpendStrip total={report.value.total} period={period} />
          <BudgetsTable budgets={budgets.value} />
          {/* The gateway policy renders its own refusal rather than blanking
              the tab: the spend ceilings above are a separate question and a
              person is still owed them when this read is down. */}
          {gateway.ok ? (
            <GatewayPolicySection
              at={at}
              policy={gateway.value}
              canEdit={ctx.wsRole === "owner" || ctx.wsRole === "admin"}
            />
          ) : (
            <SpendReadFailure read={gateway} />
          )}
        </>
      );
    }
    // The one tab whose reads are handed to the section unresolved: the book
    // and the models it cannot price are two independent questions, and a
    // person whose price book answers is still owed it when the unpriced read
    // is down (and the other way round). Each half renders its own refusal
    // rather than one of them blanking the tab.
    case "pricing": {
      const [book, unpriced] = await Promise.all([
        source.spend.priceBook(ctx),
        source.spend.unpricedModels(ctx),
      ]);
      return <PricingSection book={book} unpriced={unpriced} at={at} />;
    }
  }
}
