"use client";
/**
 * spend-budgets-panel.tsx — client orchestrator for Workspace → Settings →
 * Spend Budgets. Always renders BOTH an Organization and a
 * Workspace card (never a blank scope) and keeps each scope's live status in
 * local state, updated directly from set_spend_budget's return value on a
 * successful save — no full-page reload needed for the "success" state.
 *
 * Deliberately no history/trend chart here — get_spend_budget returns
 * point-in-time status only, with no time series. A history view needs its
 * own contract; this panel stays scoped to the current-ceiling surface.
 */
import * as React from "react";
import { ScopeBudgetCard } from "./scope-budget-card";
import type {
  SpendBudgetScope,
  SpendBudgetStatus,
} from "./spend-budget-format";

export interface SpendBudgetsPanelProps {
  orgSlug: string;
  workspaceSlug: string;
  initialBudgets: SpendBudgetStatus[];
  /** Whether the viewer holds a billing-manager role (owner/admin/billing).
   *  UI-gating only — setSpendBudgetAction re-checks this server-side on
   *  every write regardless of what the client renders. */
  canManage: boolean;
}

export function SpendBudgetsPanel({
  orgSlug,
  workspaceSlug,
  initialBudgets,
  canManage,
}: SpendBudgetsPanelProps) {
  const [budgets, setBudgets] = React.useState<
    Record<SpendBudgetScope, SpendBudgetStatus | null>
  >(() => ({
    org: initialBudgets.find((b) => b.scope === "org") ?? null,
    workspace: initialBudgets.find((b) => b.scope === "workspace") ?? null,
  }));

  const handleSaved = React.useCallback(
    (scope: SpendBudgetScope, budget: SpendBudgetStatus) => {
      setBudgets((prev) => ({ ...prev, [scope]: budget }));
    },
    [],
  );

  return (
    <div className="flex flex-col gap-4" data-testid="spend-budgets-panel">
      <ScopeBudgetCard
        scope="org"
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        budget={budgets.org}
        canManage={canManage}
        onSaved={handleSaved}
      />
      <ScopeBudgetCard
        scope="workspace"
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        budget={budgets.workspace}
        canManage={canManage}
        onSaved={handleSaved}
      />
    </div>
  );
}
