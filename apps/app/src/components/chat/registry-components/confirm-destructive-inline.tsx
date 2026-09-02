"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ConfirmDestructiveInlineProps {
  orgSlug?: string;
  workspaceSlug?: string;
  /** Short description of the destructive action (e.g. "Remove Alice from Acme") */
  title?: string;
  /** Longer explanation shown to the user */
  description?: string;
  /** Label for the confirm button (default "Confirm") */
  confirmLabel?: string;
  /** Label for the deny button (default "Cancel") */
  denyLabel?: string;
  /** Capability name to call on confirm — future: agent callback */
  onConfirmCapability?: string;
}

type FormState = "idle" | "confirmed" | "denied";

export default function ConfirmDestructiveInline({
  title = "Are you sure?",
  description,
  confirmLabel = "Confirm",
  denyLabel = "Cancel",
}: ConfirmDestructiveInlineProps): React.ReactElement {
  const [formState, setFormState] = React.useState<FormState>("idle");

  if (formState === "confirmed") {
    return (
      <div
        className={cn("rounded-2xl border border-border bg-card p-5 space-y-3")}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-3">
          <CheckCircle2
            className="h-5 w-5 shrink-0 text-success"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-foreground">Confirmed</p>
        </div>
      </div>
    );
  }

  if (formState === "denied") {
    return (
      <div
        className={cn("rounded-2xl border border-border bg-card p-5 space-y-3")}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-3">
          <XCircle
            className="h-5 w-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-foreground">Cancelled</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-2xl border border-destructive/30 bg-destructive/5 p-5 space-y-4 w-full max-w-sm",
      )}
      role="alertdialog"
      aria-label={title}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="h-4 w-4 mt-0.5 shrink-0 text-destructive"
          aria-hidden="true"
        />
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      </div>

      <div className="flex gap-3">
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          onClick={() => setFormState("denied")}
        >
          {denyLabel}
        </Button>
        <Button
          type="button"
          variant="destructive"
          className="flex-1"
          onClick={() => setFormState("confirmed")}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
