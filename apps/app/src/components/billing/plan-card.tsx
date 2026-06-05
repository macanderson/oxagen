"use client";
import * as React from "react";
import { Check } from "lucide-react";
import { Card, CardPanel, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCents, cn } from "@/lib/utils";

export interface PlanFeature {
  label: string;
}

export interface Plan {
  publicId: string;
  slug: string;
  name: string;
  tier: string;
  monthlyCents: number;
  annualCents: number | null;
  includedCreditCents: number;
  includedSeats: number;
  features: PlanFeature[];
}

/** Relationship of this plan to the org's current subscription. */
export type PlanRelation = "current" | "upgrade" | "downgrade" | "switch";

export interface PlanCardProps {
  plan: Plan;
  interval: "month" | "year";
  /** @deprecated Use `relation` instead. Kept for callers that haven't migrated yet. */
  isCurrent?: boolean;
  /** Relationship to the current subscription — drives CTA label + ring. */
  relation?: PlanRelation;
  onSelect: (slug: string, interval: "month" | "year") => void;
  pending?: boolean;
}

const RELATION_LABEL: Record<PlanRelation, string> = {
  current: "Current plan",
  upgrade: "Upgrade",
  downgrade: "Downgrade",
  switch: "Switch",
};

export function PlanCard({ plan, interval, isCurrent, relation, onSelect, pending }: PlanCardProps) {
  // Normalise: if the new `relation` prop is provided, it wins; otherwise fall
  // back to the legacy `isCurrent` boolean for backward compatibility.
  const effectiveRelation: PlanRelation =
    relation ?? (isCurrent ? "current" : "switch");

  const price = interval === "month" ? plan.monthlyCents : (plan.annualCents ?? plan.monthlyCents * 12);
  const isCur = effectiveRelation === "current";

  return (
    <Card className={cn(isCur && "ring-2 ring-primary")}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{plan.name}</CardTitle>
          {isCur ? <Badge variant="success">Current</Badge> : null}
        </div>
        <CardDescription className="capitalize">{plan.tier} tier</CardDescription>
      </CardHeader>
      <CardPanel>
        <div className="text-3xl font-semibold">
          {formatCents(price)}
          <span className="ml-1 text-sm font-normal text-muted-foreground">/{interval}</span>
        </div>
        <ul className="mt-4 space-y-2 text-sm">
          <li className="flex items-center gap-2">
            <Check className="h-3.5 w-3.5 text-primary" /> {plan.includedSeats} seats included
          </li>
          <li className="flex items-center gap-2">
            <Check className="h-3.5 w-3.5 text-primary" /> {formatCents(plan.includedCreditCents)} in credits / month
          </li>
          {plan.features.map((f) => (
            <li key={f.label} className="flex items-center gap-2">
              <Check className="h-3.5 w-3.5 text-primary" /> {f.label}
            </li>
          ))}
        </ul>
      </CardPanel>
      <CardFooter>
        <Button
          className="w-full"
          variant={isCur ? "outline" : "default"}
          disabled={pending || isCur}
          onClick={() => onSelect(plan.slug, interval)}
        >
          {isCur
            ? RELATION_LABEL.current
            : pending
              ? "Processing…"
              : RELATION_LABEL[effectiveRelation]}
        </Button>
      </CardFooter>
    </Card>
  );
}
