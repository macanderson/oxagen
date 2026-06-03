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

export interface PlanCardProps {
  plan: Plan;
  interval: "month" | "year";
  isCurrent: boolean;
  onSelect: (slug: string, interval: "month" | "year") => void;
  pending?: boolean;
}

export function PlanCard({ plan, interval, isCurrent, onSelect, pending }: PlanCardProps) {
  const price = interval === "month" ? plan.monthlyCents : (plan.annualCents ?? plan.monthlyCents * 12);
  return (
    <Card className={cn(isCurrent && "ring-2 ring-accent")}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{plan.name}</CardTitle>
          {isCurrent ? <Badge variant="success">Current</Badge> : null}
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
            <Check className="h-3.5 w-3.5 text-accent" /> {plan.includedSeats} seats included
          </li>
          <li className="flex items-center gap-2">
            <Check className="h-3.5 w-3.5 text-accent" /> {formatCents(plan.includedCreditCents)} in credits / month
          </li>
          {plan.features.map((f) => (
            <li key={f.label} className="flex items-center gap-2">
              <Check className="h-3.5 w-3.5 text-accent" /> {f.label}
            </li>
          ))}
        </ul>
      </CardPanel>
      <CardFooter>
        <Button
          className="w-full"
          variant={isCurrent ? "outline" : "default"}
          disabled={pending || isCurrent}
          onClick={() => onSelect(plan.slug, interval)}
        >
          {isCurrent ? "Current plan" : pending ? "Redirecting…" : "Choose plan"}
        </Button>
      </CardFooter>
    </Card>
  );
}
