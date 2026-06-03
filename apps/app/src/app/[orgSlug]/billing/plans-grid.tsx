"use client";
import * as React from "react";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { PlanCard, type Plan } from "@/components/billing/plan-card";
import { useToast } from "@/components/ui/toast";
import { changePlanAction } from "./actions";

export interface PlansGridProps {
  orgSlug: string;
  currentPlanSlug: string | null;
  plans: Plan[];
}

export function PlansGrid({ orgSlug, currentPlanSlug, plans }: PlansGridProps) {
  const [pending, startTransition] = React.useTransition();
  const [interval, setInterval] = React.useState<"month" | "year">("month");
  const { add: addToast } = useToast();

  const onSelect = (slug: string, chosenInterval: "month" | "year") => {
    if (slug === currentPlanSlug) return;
    startTransition(async () => {
      const res = await changePlanAction({ orgSlug, targetPlanSlug: slug, interval: chosenInterval });
      if (!res.ok) {
        addToast({ title: "Plan change failed", description: res.error, type: "error" });
        return;
      }
      if (res.url) {
        // New subscription — redirect to Stripe Checkout.
        window.location.href = res.url;
      } else {
        // In-place swap — toast success, page will re-render via revalidation.
        addToast({ title: "Plan updated", description: "Your plan has been changed.", type: "success" });
      }
    });
  };

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Plans</h2>
        <Tabs value={interval} onValueChange={(v) => setInterval(v as "month" | "year")}>
          <TabsList>
            <TabsTab value="month">Monthly</TabsTab>
            <TabsTab value="year">Annual</TabsTab>
          </TabsList>
          <TabsPanel value="month" />
          <TabsPanel value="year" />
        </Tabs>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((plan) => (
          <PlanCard
            key={plan.publicId}
            plan={plan}
            interval={interval}
            isCurrent={plan.slug === currentPlanSlug}
            onSelect={onSelect}
            pending={pending}
          />
        ))}
      </div>
    </section>
  );
}
