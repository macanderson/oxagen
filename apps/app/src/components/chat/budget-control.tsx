"use client";
import * as React from "react";
import { DollarSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { Popover, PopoverTrigger, PopoverPopup } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
// Type-only import — erased at compile time. @oxagen/billing's package.json
// only exposes one "." export mapping to its full index.ts barrel (Stripe
// client, DB-backed webhooks, etc.), so importing a VALUE from it here would
// pull that server-only surface into the client bundle. The mode copy below
// is therefore mirrored as a literal (see comment on BUDGET_MODES).
import type { TurnBudgetMode } from "@oxagen/billing";
import { saveBudgetDefaultAction } from "./budget-actions";

/**
 * Mirrors TURN_BUDGET_MODES in packages/billing/src/turn-budget.ts — THE
 * source of this copy. Kept as a literal here for the same dependency-light
 * reason the budget.policy.read/write CONTRACTS mirror it (see the comment on
 * `budgetMode` in packages/oxagen/src/contracts/budget.policy.read.ts): the
 * label/description text must stay byte-identical to the source, but this
 * client component cannot import the value without dragging in @oxagen/billing's
 * Stripe/DB-touching barrel.
 */
const BUDGET_MODES: ReadonlyArray<{
  mode: TurnBudgetMode;
  label: string;
  description: string;
}> = [
  {
    mode: "grace",
    label: "Allow overage (grace window)",
    description:
      "Soft cap — keep going past the limit up to a grace cushion, then stop automatically.",
  },
  {
    mode: "prompt",
    label: "Ask to continue",
    description:
      "Gated cap — pause at the limit and ask for approval before spending more.",
  },
  {
    mode: "enforce",
    label: "Hard stop",
    description:
      "Hard cap — halt the turn the instant the limit is crossed and fail with a budget-exceeded reason.",
  },
];

const DEFAULT_GRACE_PCT = 0.25;

export interface BudgetControlValue {
  budgetEnabled: boolean;
  budgetUsd: number | null;
  budgetMode: TurnBudgetMode;
  budgetGracePct: number;
}

export interface BudgetControlProps extends BudgetControlValue {
  onChange: (patch: Partial<BudgetControlValue>) => void;
}

/** Compact per-turn dollar budget control for the composer toolbar. Off by
 * default; opens a popover with an on/off toggle, a limit input, and a mode
 * picker whose copy is sourced from TURN_BUDGET_MODES. */
export function BudgetControl({
  budgetEnabled,
  budgetUsd,
  budgetMode,
  budgetGracePct,
  onChange,
}: BudgetControlProps) {
  const [saveState, setSaveState] = React.useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const saveResetTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(saveResetTimer.current), []);

  async function saveAsDefault() {
    setSaveState("saving");
    const res = await saveBudgetDefaultAction({
      enabled: budgetEnabled,
      limitUsd: budgetEnabled ? budgetUsd : null,
      mode: budgetMode,
      graceOveragePct: budgetGracePct,
    });
    setSaveState(res.ok ? "saved" : "error");
    clearTimeout(saveResetTimer.current);
    saveResetTimer.current = setTimeout(() => setSaveState("idle"), 2500);
  }

  const activeMeta = BUDGET_MODES.find((m) => m.mode === budgetMode);
  const triggerLabel =
    budgetEnabled && budgetUsd ? `$${budgetUsd.toFixed(2)}` : null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={
              triggerLabel
                ? `Per-turn budget: ${triggerLabel}`
                : "Per-turn budget (off)"
            }
            className={cn(
              "h-8 gap-1 px-2 text-xs font-medium",
              budgetEnabled &&
                "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary",
            )}
          />
        }
      >
        <DollarSign className="h-3.5 w-3.5" />
        {triggerLabel ? (
          <span className="tabular-nums">{triggerLabel}</span>
        ) : null}
      </PopoverTrigger>

      <PopoverPopup align="start" sideOffset={8} className="w-80 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="budget-enabled-switch" className="text-sm font-medium">
            Per-turn budget
          </Label>
          <Switch
            id="budget-enabled-switch"
            checked={budgetEnabled}
            onCheckedChange={(checked) => onChange({ budgetEnabled: checked })}
          />
        </div>

        {budgetEnabled ? (
          <>
            <div className="space-y-1">
              <Label htmlFor="budget-limit-input" className="text-xs text-muted-foreground">
                Limit (USD)
              </Label>
              <Input
                id="budget-limit-input"
                type="number"
                inputMode="decimal"
                min={0.01}
                step={0.01}
                size="sm"
                placeholder="e.g. 1.00"
                value={budgetUsd ?? ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "") {
                    onChange({ budgetUsd: null });
                    return;
                  }
                  const parsedValue = Number(raw);
                  onChange({
                    budgetUsd:
                      Number.isFinite(parsedValue) && parsedValue > 0
                        ? parsedValue
                        : null,
                  });
                }}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                When the limit is reached
              </Label>
              <Select
                value={budgetMode}
                onValueChange={(v) => onChange({ budgetMode: v as TurnBudgetMode })}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {BUDGET_MODES.map((m) => (
                    <SelectItem key={m.mode} value={m.mode}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {activeMeta ? (
                <p className="text-xs text-muted-foreground">{activeMeta.description}</p>
              ) : null}
            </div>

            {budgetMode === "grace" ? (
              <div className="space-y-1">
                <Label htmlFor="budget-grace-input" className="text-xs text-muted-foreground">
                  Grace cushion (% above the limit)
                </Label>
                <Input
                  id="budget-grace-input"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={1000}
                  step={5}
                  size="sm"
                  value={Math.round(budgetGracePct * 100)}
                  onChange={(e) => {
                    const pct = Number(e.target.value);
                    onChange({
                      budgetGracePct: Number.isFinite(pct)
                        ? Math.max(0, pct) / 100
                        : DEFAULT_GRACE_PCT,
                    });
                  }}
                />
              </div>
            ) : null}
          </>
        ) : null}

        <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
          <span className="text-xs text-muted-foreground">
            {saveState === "saved"
              ? "Saved as your default"
              : saveState === "error"
                ? "Failed to save — try again"
                : "Applies to this turn only"}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={saveAsDefault}
            disabled={saveState === "saving"}
          >
            {saveState === "saving" ? "Saving…" : "Save as default"}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
