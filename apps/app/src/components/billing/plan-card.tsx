"use client";
import * as React from "react";
import { Check } from "lucide-react";
import { Panel } from "@/components/ui/panel";
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

export function PlanCard({
  plan,
  interval,
  relation,
  onSelect,
  pending,
}: PlanCardProps) {
  const effectiveRelation: PlanRelation = relation ?? "switch";

  const price =
    interval === "month"
      ? plan.monthlyCents
      : (plan.annualCents ?? plan.monthlyCents * 12);
  const isCur = effectiveRelation === "current";

  return (
    <Panel
      className={cn(isCur && "ring-2 ring-primary")}
      title={
        <span className="flex items-center justify-between w-full">
          <span>{plan.name}</span>
          {isCur ? <Badge variant="success">Current</Badge> : null}
        </span>
      }
      eyebrow={<span className="capitalize">{plan.tier} tier</span>}
      footer={
        <Button
          className="w-full"
          variant={isCur ? "outline" : "gradient"}
          disabled={pending || isCur}
          onClick={() => onSelect(plan.slug, interval)}
        >
          {isCur
            ? RELATION_LABEL.current
            : pending
              ? "Processing…"
              : RELATION_LABEL[effectiveRelation]}
        </Button>
      }
    >
      <div className="text-3xl font-semibold">
        {formatCents(price)}
        <span className="ml-1 text-sm font-normal text-muted-foreground">
          /{interval}
        </span>
      </div>
      <ul className="mt-4 space-y-2 text-sm">
        <li className="flex items-center gap-2">
          <Check className="h-3.5 w-3.5 text-primary" /> {plan.includedSeats}{" "}
          seats included
        </li>
        <li className="flex items-center gap-2">
          <Check className="h-3.5 w-3.5 text-primary" />{" "}
          {formatCents(plan.includedCreditCents)} in credits / month
        </li>
        {plan.features.map((f) => (
          <li key={f.label} className="flex items-center gap-2">
            <Check className="h-3.5 w-3.5 text-primary" /> {f.label}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
