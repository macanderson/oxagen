"use client";

import * as React from "react";
import { Cpu, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { updateModelSettingsAction } from "@/app/actions/update-model-settings.action";
import { cn } from "@/lib/utils";

export interface ModelSettingsInlineProps {
  orgSlug?: string;
  workspaceSlug?: string;
  /** Current tier, pre-filled from context */
  currentTier?: string;
}

type FormState = "idle" | "submitting" | "success" | "error";
type TextTier = "fast" | "balanced" | "precise";

export default function ModelSettingsInline({
  orgSlug = "",
  workspaceSlug = "",
  currentTier,
}: ModelSettingsInlineProps): React.ReactElement {
  const [tier, setTier] = React.useState<TextTier>(
    (currentTier as TextTier | undefined) ?? "balanced",
  );
  const [formState, setFormState] = React.useState<FormState>("idle");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const tierId = React.useId();

  const isSubmitting = formState === "submitting";

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormState("submitting");
    setErrorMessage(null);

    const result = await updateModelSettingsAction({
      orgSlug,
      workspaceSlug,
      defaultTextTier: tier,
    });

    if (result.ok) {
      setFormState("success");
    } else {
      setErrorMessage(result.error);
      setFormState("error");
    }
  }

  if (formState === "success") {
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
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Model settings updated
            </p>
            <p className="truncate text-xs text-muted-foreground">
              Default tier: {tier}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Model settings"
      className={cn(
        "rounded-2xl border border-border bg-card p-5 space-y-5 w-full max-w-sm",
      )}
    >
      <div className="flex items-center gap-2.5">
        <Cpu
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold text-foreground">
          Model settings
        </span>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={tierId}>Default model tier</Label>
        <Select
          value={tier}
          onValueChange={(v) => {
            if (v !== null) setTier(v as TextTier);
          }}
          disabled={isSubmitting}
          name="tier"
        >
          <SelectTrigger id={tierId} aria-label="Default model tier">
            <SelectValue placeholder="Select tier" />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="fast">
              Fast — lower cost, quick responses
            </SelectItem>
            <SelectItem value="balanced">Balanced — best value</SelectItem>
            <SelectItem value="precise">Precise — most capable</SelectItem>
          </SelectPopup>
        </Select>
      </div>

      {formState === "error" && errorMessage !== null && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errorMessage}
        </p>
      )}

      <Button
        type="submit"
        disabled={isSubmitting}
        className="w-full"
        aria-busy={isSubmitting}
      >
        {isSubmitting ? "Saving…" : "Save settings"}
      </Button>
    </form>
  );
}
