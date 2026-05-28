"use client";
import * as React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PlanCard, type Plan } from "@/components/billing/plan-card";
import { subscribeAction } from "./actions";

export interface PlansGridProps {
  tenantSlug: string;
  currentPlanSlug: string | null;
  plans: Plan[];
}

export function PlansGrid({ tenantSlug, currentPlanSlug, plans }: PlansGridProps) {
  const [pending, startTransition] = React.useTransition();
  const [interval, setInterval] = React.useState<"month" | "year">("month");

  const onSelect = (slug: string, chosenInterval: "month" | "year") => {
    startTransition(async () => {
      const res = await subscribeAction({ tenantSlug, planSlug: slug, interval: chosenInterval });
      if (res.ok && res.url) window.location.href = res.url;
    });
  };

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Plans</h2>
        <Tabs value={interval} onValueChange={(v) => setInterval(v as "month" | "year")}>
          <TabsList>
            <TabsTrigger value="month">Monthly</TabsTrigger>
            <TabsTrigger value="year">Annual</TabsTrigger>
          </TabsList>
          <TabsContent value="month" />
          <TabsContent value="year" />
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
