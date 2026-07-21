"use client";
/**
 * scope-budget-card.tsx — one scope's (org or workspace) ceiling card for the
 * Spend Budgets panel (OXA-1079). Renders one of:
 *   - an EmptyState ("No ceiling configured") with a control to set one,
 *   - a configured, DISABLED ceiling — saved but not gating anything right
 *     now (getAllScopeBudgets returns disabled rows too, so this is a real,
 *     reachable state, not dead code) — shown distinctly from both the
 *     empty state and an active ceiling, never with the "exceeded/denied"
 *     framing (a disabled ceiling isn't denying runs even if spend has
 *     crossed the configured limit), or
 *   - a configured, ENABLED ceiling's live burn (limit, spend, projection,
 *     ratio, window, state), with an "exceeded" ceiling getting a dedicated
 *     alert banner (agent runs are being denied right now),
 * plus, in every case, an inline edit form (enabled / period / windowDays /
 * limitUsd) that mirrors the contract's rolling/monthly refine client-side —
 * gated behind `canManage` (a Member can view the burn but not edit it; the
 * real enforcement is setSpendBudgetAction's server-side billing-manager gate,
 * this is UI-gating only).
 */
import * as React from "react";
import { AlertTriangle, PiggyBank, Save, ShieldOff } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardPanel,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { setSpendBudgetAction } from "./actions";
import {
  formatUsd,
  formatWindow,
  SCOPE_DESCRIPTION,
  SCOPE_LABEL,
  STATE_META,
  validateLimitUsd,
  validateWindowDays,
  type SpendBudgetPeriod,
  type SpendBudgetScope,
  type SpendBudgetStatus,
} from "./spend-budget-format";

const MANAGE_DENIED_NOTE =
  "Only owners, admins, and billing managers can change spend ceilings.";

export interface ScopeBudgetCardProps {
  scope: SpendBudgetScope;
  orgSlug: string;
  workspaceSlug: string;
  /** Current status, or null when no ceiling is configured for this scope. */
  budget: SpendBudgetStatus | null;
  /** Whether the viewer may create/edit this scope's ceiling. UI-gating
   *  only — setSpendBudgetAction re-checks server-side regardless. */
  canManage: boolean;
  onSaved: (scope: SpendBudgetScope, budget: SpendBudgetStatus) => void;
}

/** Bar color reflects enforcement, not just the raw ratio: a disabled
 *  ceiling renders neutral even if spend has crossed the configured limit,
 *  since it isn't gating anything right now. */
function barColorClass(budget: SpendBudgetStatus): string {
  if (!budget.enabled) return "bg-muted-foreground/40";
  if (budget.state === "exceeded") return "bg-destructive";
  if (budget.state === "threshold_80" || budget.state === "threshold_95")
    return "bg-warning";
  return "bg-success";
}

export function ScopeBudgetCard({
  scope,
  orgSlug,
  workspaceSlug,
  budget,
  canManage,
  onSaved,
}: ScopeBudgetCardProps) {
  const [isEditing, setIsEditing] = React.useState(false);
  const [enabled, setEnabled] = React.useState(budget?.enabled ?? true);
  const [period, setPeriod] = React.useState<SpendBudgetPeriod>(
    budget?.period ?? "monthly",
  );
  const [windowDays, setWindowDays] = React.useState<number | null>(
    budget?.windowDays ?? null,
  );
  const [limitUsd, setLimitUsd] = React.useState<number | null>(
    budget?.limitUsd ?? null,
  );
  const [formError, setFormError] = React.useState<string | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);

  function startEdit() {
    // Defensive — the buttons that call this are hidden when !canManage, but
    // guard the entry point too rather than trusting only the render branch.
    if (!canManage) return;
    setEnabled(budget?.enabled ?? true);
    setPeriod(budget?.period ?? "monthly");
    setWindowDays(budget?.windowDays ?? null);
    setLimitUsd(budget?.limitUsd ?? null);
    setFormError(null);
    setIsEditing(true);
  }

  async function handleSave(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);

    const limitError = validateLimitUsd(limitUsd);
    if (limitError) {
      setFormError(limitError);
      return;
    }
    const windowError = validateWindowDays(
      period,
      period === "rolling" ? windowDays : null,
    );
    if (windowError) {
      setFormError(windowError);
      return;
    }

    setIsSaving(true);
    try {
      const result = await setSpendBudgetAction(orgSlug, workspaceSlug, {
        scope,
        enabled,
        period,
        windowDays: period === "rolling" ? windowDays : null,
        limitUsd: limitUsd as number,
      });
      if (result.ok) {
        onSaved(scope, result.budget);
        setSavedAt(new Date());
        setIsEditing(false);
      } else {
        setFormError(result.error);
      }
    } catch {
      setFormError("An unexpected error occurred. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  const testBase = `spend-budget-${scope}`;
  // A disabled ceiling is a distinct third state — never "exceeded/denied"
  // (that framing would be actively misleading: disabled means nothing is
  // being gated right now, however high the ratio reads) and never the
  // active-ceiling badge either.
  const isDisabledCeiling = budget !== null && !budget.enabled;
  const isExceeded =
    budget !== null && budget.enabled && budget.state === "exceeded";
  const stateMeta = budget && budget.enabled ? STATE_META[budget.state] : null;

  return (
    <Card data-testid={`${testBase}-card`}>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle className="text-base">{SCOPE_LABEL[scope]}</CardTitle>
          <CardDescription>{SCOPE_DESCRIPTION[scope]}</CardDescription>
        </div>
        {budget ? (
          <Badge
            variant={
              isDisabledCeiling ? "muted" : (stateMeta?.badgeVariant ?? "muted")
            }
            data-testid={`${testBase}-state`}
          >
            {isDisabledCeiling
              ? "Disabled — not enforced"
              : (stateMeta?.label ?? "")}
          </Badge>
        ) : null}
      </CardHeader>

      <CardPanel className="flex flex-col gap-4 pt-4">
        {isExceeded ? (
          <Alert variant="error" data-testid={`${testBase}-exceeded-alert`}>
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>
              Ceiling exceeded — agent runs are being denied
            </AlertTitle>
            <AlertDescription>
              Spend for this scope has crossed the configured limit. Raise the
              ceiling below to clear the denial, or wait for the period to roll
              over.
            </AlertDescription>
          </Alert>
        ) : null}

        {isDisabledCeiling ? (
          <Alert variant="warning" data-testid={`${testBase}-disabled-alert`}>
            <ShieldOff aria-hidden="true" />
            <AlertTitle>Ceiling disabled — not enforced</AlertTitle>
            <AlertDescription>
              This ceiling is saved but is not currently gating agent runs in
              this scope, even if spend below has crossed the configured limit.
              Turn it back on below to enforce it again.
            </AlertDescription>
          </Alert>
        ) : null}

        {!budget && !isEditing ? (
          <EmptyState
            data-testid={`${testBase}-empty`}
            icon={<PiggyBank aria-hidden="true" />}
            title="No ceiling configured"
            description={`This scope has no spend ceiling yet. ${SCOPE_DESCRIPTION[scope]}`}
            action={
              canManage ? (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`${testBase}-set-button`}
                  onClick={startEdit}
                >
                  Set a ceiling
                </Button>
              ) : (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid={`${testBase}-readonly-note`}
                >
                  {MANAGE_DENIED_NOTE}
                </p>
              )
            }
          />
        ) : null}

        {budget && !isEditing ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">Limit</p>
                <p className="font-medium text-foreground">
                  {budget.limitUsd != null ? formatUsd(budget.limitUsd) : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Spent</p>
                <p className="font-medium text-foreground">
                  {formatUsd(budget.spentUsd)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Projected</p>
                <p className="font-medium text-foreground">
                  {formatUsd(budget.projectedUsd)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Window</p>
                <p className="font-medium text-foreground">
                  {formatWindow(budget.windowStart, budget.windowEnd)}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{Math.round(budget.ratio * 100)}% of ceiling</span>
                <span>
                  {budget.period === "rolling"
                    ? `${budget.windowDays}-day rolling`
                    : "Monthly"}
                </span>
              </div>
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={Math.round(budget.ratio * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${SCOPE_LABEL[scope]} spend at ${Math.round(budget.ratio * 100)} percent of ceiling`}
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-[width]",
                    barColorClass(budget),
                  )}
                  style={{ width: `${Math.min(budget.ratio * 100, 100)}%` }}
                />
              </div>
            </div>

            <div>
              {canManage ? (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`${testBase}-edit-button`}
                  onClick={startEdit}
                >
                  {isDisabledCeiling
                    ? "Edit / re-enable ceiling"
                    : "Edit ceiling"}
                </Button>
              ) : (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid={`${testBase}-readonly-note`}
                >
                  {MANAGE_DENIED_NOTE}
                </p>
              )}
              {savedAt !== null ? (
                <span className="ml-3 text-xs text-muted-foreground">
                  Saved at{" "}
                  {savedAt.toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {isEditing && canManage ? (
          <form
            onSubmit={handleSave}
            aria-label={`${SCOPE_LABEL[scope]} spend ceiling`}
            data-testid={`${testBase}-form`}
            className="flex flex-col gap-4"
            noValidate
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <Label
                  htmlFor={`${testBase}-enabled`}
                  className="text-sm font-medium"
                >
                  Enforce this ceiling
                </Label>
                <p className="text-xs text-muted-foreground">
                  Off keeps the saved values but stops gating agent runs on this
                  scope.
                </p>
              </div>
              <Switch
                id={`${testBase}-enabled`}
                checked={enabled}
                disabled={isSaving}
                onCheckedChange={setEnabled}
              />
            </div>

            <div className="space-y-1">
              <Label
                htmlFor={`${testBase}-limit`}
                className="text-xs text-muted-foreground"
              >
                Limit (USD)
              </Label>
              <Input
                id={`${testBase}-limit`}
                data-testid={`${testBase}-limit-input`}
                type="number"
                inputMode="decimal"
                min={0.01}
                step={0.01}
                size="sm"
                disabled={isSaving}
                placeholder="e.g. 500.00"
                value={limitUsd ?? ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "") {
                    setLimitUsd(null);
                    return;
                  }
                  const parsed = Number(raw);
                  setLimitUsd(Number.isFinite(parsed) ? parsed : null);
                }}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Period</Label>
              <Select
                value={period}
                onValueChange={(v) => {
                  const next = v as SpendBudgetPeriod;
                  setPeriod(next);
                  if (next === "monthly") setWindowDays(null);
                }}
              >
                <SelectTrigger size="sm" className="w-full" disabled={isSaving}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="monthly">
                    Monthly (calendar month to date)
                  </SelectItem>
                  <SelectItem value="rolling">
                    Rolling (trailing N days)
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>

            {period === "rolling" ? (
              <div className="space-y-1">
                <Label
                  htmlFor={`${testBase}-window-days`}
                  className="text-xs text-muted-foreground"
                >
                  Rolling window (days)
                </Label>
                <Input
                  id={`${testBase}-window-days`}
                  data-testid={`${testBase}-window-days-input`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  size="sm"
                  disabled={isSaving}
                  placeholder="e.g. 30"
                  value={windowDays ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      setWindowDays(null);
                      return;
                    }
                    const parsed = Number(raw);
                    setWindowDays(
                      Number.isFinite(parsed) ? Math.trunc(parsed) : null,
                    );
                  }}
                />
              </div>
            ) : null}

            {formError !== null ? (
              <p
                role="alert"
                className="text-sm text-destructive"
                data-testid={`${testBase}-form-error`}
              >
                {formError}
              </p>
            ) : null}

            <div className="flex items-center gap-3">
              <Button
                type="submit"
                variant="gradient"
                size="sm"
                data-testid={`${testBase}-save`}
                disabled={isSaving}
                startIcon={<Save className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                {isSaving ? "Saving…" : "Save ceiling"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isSaving}
                onClick={() => {
                  setFormError(null);
                  setIsEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </CardPanel>
    </Card>
  );
}
