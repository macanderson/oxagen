"use client";

import * as React from "react";
import { CreditCard, CheckCircle2, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { changePlanAction } from "@/app/[orgSlug]/billing/actions";
import { cn } from "@/lib/utils";

export interface BillingUpgradeInlineProps {
  orgSlug?: string;
  workspaceSlug?: string;
  /** Pre-selected plan slug from agent inference */
  suggestedPlan?: string;
}

type FormState = "idle" | "submitting" | "success" | "error";

const PLANS = [
  {
    slug: "build",
    label: "Build",
    price: "$20/mo",
    description: "For individuals and small teams",
  },
  {
    slug: "scale",
    label: "Scale",
    price: "$99/mo",
    description: "For growing teams",
  },
  {
    slug: "enterprise",
    label: "Enterprise",
    price: "$500/mo",
    description: "For large organizations with ACLs",
  },
] as const;

type PlanSlug = (typeof PLANS)[number]["slug"];

export default function BillingUpgradeInline({
  orgSlug = "",
  suggestedPlan,
}: BillingUpgradeInlineProps): React.ReactElement {
  const [selected, setSelected] = React.useState<PlanSlug>(
    (suggestedPlan as PlanSlug | undefined) ?? "build",
  );
  const [formState, setFormState] = React.useState<FormState>("idle");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const isSubmitting = formState === "submitting";

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormState("submitting");
    setErrorMessage(null);

    const result = await changePlanAction({
      orgSlug,
      targetPlanSlug: selected,
      interval: "month",
    });

    if (result.ok) {
      setFormState("success");
      if (result.url) {
        window.location.assign(result.url);
      }
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
      aria-label="Upgrade plan"
      className={cn(
        "rounded-2xl border border-border bg-card p-5 space-y-5 w-full max-w-sm",
      )}
    >
      <div className="flex items-center gap-2.5">
        <CreditCard
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold text-foreground">
          Upgrade plan
        </span>
      </div>

      <div className="space-y-2">
        {PLANS.map((plan) => (
          <button
            key={plan.slug}
            type="button"
            onClick={() => setSelected(plan.slug)}
            disabled={isSubmitting}
            className={cn(
              "w-full text-left rounded-xl border p-3 transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              selected === plan.slug
                ? "border-primary bg-primary/5"
                : "border-border hover:border-border/80 hover:bg-accent/30",
            )}
            aria-pressed={selected === plan.slug}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">
                {plan.label}
              </span>
              <span className="text-xs font-medium text-muted-foreground">
                {plan.price}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {plan.description}
            </p>
          </button>
        ))}
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
        {isSubmitting ? (
          "Starting checkout…"
        ) : (
          <span className="flex items-center gap-1.5">
            Upgrade to {PLANS.find((p) => p.slug === selected)?.label}
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        )}
      </Button>
    </form>
  );
}
