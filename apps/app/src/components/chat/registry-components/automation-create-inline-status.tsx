"use client";

/**
 * automation-create-inline-status.tsx — Post-submit UI states for the
 * automation-create-inline chat component:
 *   • CreatedState  — automation created but disabled; offers Enable / Leave disabled
 *   • EnabledState  — automation is now live
 */

import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AutomationCreateOutput } from "@oxagen/oxagen/contracts/automation.create";

// ── CreatedState ───────────────────────────────────────────────────────────────

interface CreatedStateProps {
  createdAutomation: AutomationCreateOutput | null;
  fallbackName: string;
  enableError: string | null;
  isEnabling: boolean;
  onEnable: () => void;
}

export function CreatedState({
  createdAutomation,
  fallbackName,
  enableError,
  isEnabling,
  onEnable,
}: CreatedStateProps): React.ReactElement {
  return (
    <div
      className={cn("rounded-2xl border border-border bg-card p-5 space-y-4")}
      role="status"
      aria-live="polite"
      data-testid="automation-created-state"
    >
      <div className="flex items-start gap-3">
        <CheckCircle2
          className="h-5 w-5 shrink-0 text-success mt-0.5"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            Created — disabled
          </p>
          <p className="truncate text-xs text-muted-foreground mt-0.5">
            {createdAutomation?.name ?? fallbackName}
            {createdAutomation?.automation_id
              ? ` · ${createdAutomation.automation_id}`
              : ""}
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
          Disabled
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        The automation was created but is not live yet. Enable it when you are
        ready.
      </p>

      {enableError !== null && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {enableError}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          onClick={onEnable}
          disabled={isEnabling}
          aria-busy={isEnabling}
          data-testid="enable-automation-btn"
        >
          {isEnabling ? "Enabling…" : "Enable automation"}
        </Button>
        <button
          type="button"
          onClick={() => {
            /* The user explicitly leaves it disabled — no action needed */
          }}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Leave automation disabled"
          data-testid="leave-disabled-btn"
        >
          Leave disabled
        </button>
      </div>
    </div>
  );
}

// ── EnabledState ───────────────────────────────────────────────────────────────

interface EnabledStateProps {
  createdAutomation: AutomationCreateOutput | null;
  fallbackName: string;
}

export function EnabledState({
  createdAutomation,
  fallbackName,
}: EnabledStateProps): React.ReactElement {
  return (
    <div
      className={cn("rounded-2xl border border-border bg-card p-5 space-y-3")}
      role="status"
      aria-live="polite"
      data-testid="automation-enabled-state"
    >
      <div className="flex items-center gap-3">
        <CheckCircle2
          className="h-5 w-5 shrink-0 text-success"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            Automation enabled
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {createdAutomation?.name ?? fallbackName} is now live
          </p>
        </div>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium text-success">
          Active
        </span>
      </div>
    </div>
  );
}
