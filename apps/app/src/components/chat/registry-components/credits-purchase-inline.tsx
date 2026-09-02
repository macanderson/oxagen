"use client";

import * as React from "react";
import { Coins, CheckCircle2, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { buyCreditsAction } from "@/app/[orgSlug]/billing/actions";
import { cn } from "@/lib/utils";

export interface CreditsPurchaseInlineProps {
  orgSlug?: string;
  workspaceSlug?: string;
  /** Pre-suggested credit amount in USD from agent inference */
  suggestedAmountUsd?: number;
}

type FormState = "idle" | "submitting" | "success" | "error";

const PRESET_AMOUNTS = [10, 25, 50, 100] as const;

export default function CreditsPurchaseInline({
  orgSlug = "",
  suggestedAmountUsd,
}: CreditsPurchaseInlineProps): React.ReactElement {
  const [amountUsd, setAmountUsd] = React.useState<number>(
    suggestedAmountUsd ?? 25,
  );
  const [customAmount, setCustomAmount] = React.useState<string>(
    suggestedAmountUsd ? String(suggestedAmountUsd) : "",
  );
  const [useCustom, setUseCustom] = React.useState(
    suggestedAmountUsd !== undefined &&
      !PRESET_AMOUNTS.includes(
        suggestedAmountUsd as (typeof PRESET_AMOUNTS)[number],
      ),
  );
  const [formState, setFormState] = React.useState<FormState>("idle");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const customId = React.useId();

  const isSubmitting = formState === "submitting";

  const effectiveAmount = useCustom ? parseFloat(customAmount) || 0 : amountUsd;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormState("submitting");
    setErrorMessage(null);

    if (effectiveAmount < 5) {
      setErrorMessage("Minimum purchase is $5.");
      setFormState("error");
      return;
    }

    const result = await buyCreditsAction({
      orgSlug,
      amountUsd: effectiveAmount,
    });

    if (result.ok) {
      setFormState("success");
      window.location.assign(result.url);
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
          <p className="text-sm font-medium text-foreground">
            Redirecting to checkout…
          </p>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Purchase credits"
      className={cn(
        "rounded-2xl border border-border bg-card p-5 space-y-5 w-full max-w-sm",
      )}
    >
      <div className="flex items-center gap-2.5">
        <Coins
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold text-foreground">
          Purchase credits
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          1 credit = $0.01
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {PRESET_AMOUNTS.map((amt) => (
          <button
            key={amt}
            type="button"
            onClick={() => {
              setAmountUsd(amt);
              setUseCustom(false);
            }}
            disabled={isSubmitting}
            className={cn(
              "rounded-xl border py-2 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              !useCustom && amountUsd === amt
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground",
            )}
            aria-pressed={!useCustom && amountUsd === amt}
          >
            ${amt}
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={customId}>Custom amount (USD)</Label>
        <Input
          id={customId}
          type="number"
          min={5}
          step={1}
          placeholder="e.g. 75"
          value={customAmount}
          onFocus={() => setUseCustom(true)}
          onChange={(e) => {
            setCustomAmount(e.target.value);
            setUseCustom(true);
          }}
          disabled={isSubmitting}
          aria-label="Custom credit amount in USD"
        />
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
        disabled={isSubmitting || effectiveAmount < 5}
        className="w-full"
        aria-busy={isSubmitting}
      >
        {isSubmitting ? (
          "Starting checkout…"
        ) : (
          <span className="flex items-center gap-1.5">
            Buy ${effectiveAmount} in credits
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        )}
      </Button>
    </form>
  );
}
