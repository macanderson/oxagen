"use client";
/**
 * budget-form.tsx — client component for Workspace → Settings → Budget.
 *
 * Renders the governed per-turn budget fields (enabled, USD limit, mode,
 * grace %, enforcement) and saves changes via updateWorkspaceBudgetAction.
 * Save/toast UX mirrors ../models/models-form.tsx.
 */
import * as React from "react";
import { Save } from "lucide-react";
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
// Type-only import — erased at compile time, same rationale as
// components/chat/budget-control.tsx: this is a "use client" component, and
// @oxagen/billing's package.json exposes only its full index.ts barrel
// (Stripe client, DB-backed webhooks), so importing a VALUE from it here
// would drag that server-only surface into the client bundle. The mode
// label/description copy is therefore mirrored as a literal below.
import type { TurnBudgetMode } from "@oxagen/billing";
import type { WorkspaceBudgetPolicyReadOutput } from "@oxagen/oxagen/contracts/workspace.budget_policy.read";
import {
  updateWorkspaceBudgetAction,
  type WorkspaceBudgetActionResult,
} from "./budget-action";

/** Mirrors TURN_BUDGET_MODES in packages/billing/src/turn-budget.ts — see the
 * identical comment on budget-control.tsx's BUDGET_MODES for why this is a
 * local literal rather than an import. */
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

export interface WorkspaceBudgetFormProps {
  /** Current workspace budget policy (from workspace.budget.policy.read). */
  initial: WorkspaceBudgetPolicyReadOutput;
  /** Whether the viewing user may save changes (workspace owner or admin). */
  canEdit: boolean;
  orgSlug: string;
  workspaceSlug: string;
}

export function WorkspaceBudgetForm({
  initial,
  canEdit,
  orgSlug,
  workspaceSlug,
}: WorkspaceBudgetFormProps) {
  const [enabled, setEnabled] = React.useState(initial.enabled);
  const [limitUsd, setLimitUsd] = React.useState<number | null>(
    initial.limitUsd,
  );
  const [mode, setMode] = React.useState<TurnBudgetMode>(initial.mode);
  const [gracePct, setGracePct] = React.useState(initial.graceOveragePct);
  const [enforcement, setEnforcement] = React.useState<"default" | "ceiling">(
    initial.enforcement,
  );
  const [isSaving, setIsSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const activeMeta = BUDGET_MODES.find((m) => m.mode === mode);
  const disabled = !canEdit || isSaving;

  async function handleSave(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsSaving(true);
    setError(null);
    try {
      const result: WorkspaceBudgetActionResult =
        await updateWorkspaceBudgetAction({
          orgSlug,
          workspaceSlug,
          enabled,
          limitUsd: enabled ? limitUsd : null,
          mode,
          graceOveragePct: gracePct,
          enforcement,
        });
      if (result.ok) {
        setSavedAt(new Date());
      } else {
        setError(result.error);
      }
    } catch {
      // Never surface a raw thrown error in the form UI.
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <form
        onSubmit={handleSave}
        aria-label="Workspace turn budget"
        className="flex flex-col gap-6"
        noValidate
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Label
              htmlFor="workspace-budget-enabled"
              className="text-sm font-medium"
            >
              Govern the turn budget
            </Label>
            <p className="text-xs text-muted-foreground">
              Off means members use their own personal budget preference,
              unrestricted.
            </p>
          </div>
          <Switch
            id="workspace-budget-enabled"
            checked={enabled}
            disabled={disabled}
            onCheckedChange={setEnabled}
          />
        </div>

        {enabled ? (
          <>
            <div className="space-y-1">
              <Label
                htmlFor="workspace-budget-limit"
                className="text-xs text-muted-foreground"
              >
                Limit (USD)
              </Label>
              <Input
                id="workspace-budget-limit"
                type="number"
                inputMode="decimal"
                min={0.01}
                step={0.01}
                size="sm"
                className="max-md:h-11"
                disabled={disabled}
                placeholder="e.g. 5.00"
                value={limitUsd ?? ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "") {
                    setLimitUsd(null);
                    return;
                  }
                  const parsed = Number(raw);
                  setLimitUsd(
                    Number.isFinite(parsed) && parsed > 0 ? parsed : null,
                  );
                }}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                When the limit is reached
              </Label>
              <Select
                value={mode}
                onValueChange={(v) => setMode(v as TurnBudgetMode)}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full max-md:h-11"
                  disabled={disabled}
                >
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
                <p className="text-xs text-muted-foreground">
                  {activeMeta.description}
                </p>
              ) : null}
            </div>

            {mode === "grace" ? (
              <div className="space-y-1">
                <Label
                  htmlFor="workspace-budget-grace"
                  className="text-xs text-muted-foreground"
                >
                  Grace cushion (% above the limit)
                </Label>
                <Input
                  id="workspace-budget-grace"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={1000}
                  step={5}
                  size="sm"
                  className="max-md:h-11"
                  disabled={disabled}
                  value={Math.round(gracePct * 100)}
                  onChange={(e) => {
                    const pct = Number(e.target.value);
                    setGracePct(
                      Number.isFinite(pct)
                        ? Math.max(0, pct) / 100
                        : DEFAULT_GRACE_PCT,
                    );
                  }}
                />
              </div>
            ) : null}

            <fieldset className="space-y-2" disabled={disabled}>
              <legend className="text-xs text-muted-foreground">
                Enforcement
              </legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="workspace-budget-enforcement"
                  className="mt-1"
                  checked={enforcement === "ceiling"}
                  onChange={() => setEnforcement("ceiling")}
                  disabled={disabled}
                />
                <span>
                  <span className="font-medium text-foreground">
                    Hard ceiling
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Members can&apos;t exceed this limit or pick a laxer mode —
                    the composer clamps their own budget down to this ceiling.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="workspace-budget-enforcement"
                  className="mt-1"
                  checked={enforcement === "default"}
                  onChange={() => setEnforcement("default")}
                  disabled={disabled}
                />
                <span>
                  <span className="font-medium text-foreground">Default</span>
                  <span className="block text-xs text-muted-foreground">
                    Only seeds a member who hasn&apos;t set their own budget yet
                    — members can still raise or lower it.
                  </span>
                </span>
              </label>
            </fieldset>
          </>
        ) : null}

        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3 pt-2">
          <Button
            type="submit"
            variant="gradient"
            size="sm"
            className="max-md:h-11"
            disabled={isSaving || !canEdit}
            startIcon={<Save className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            {isSaving ? "Saving…" : "Save changes"}
          </Button>

          {savedAt !== null && (
            <p className="text-xs text-muted-foreground">
              Saved at{" "}
              {savedAt.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          )}

          {!canEdit && (
            <p className="text-xs text-muted-foreground">
              Only workspace owners and admins can edit the workspace budget.
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
