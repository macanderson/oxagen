"use client";
import * as React from "react";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { PlanCard, type Plan, type PlanRelation } from "@/components/billing/plan-card";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { formatCents } from "@/lib/utils";
import { changePlanAction, previewPlanAction } from "./actions";
import type { PlanChangePreview } from "@oxagen/billing";

export interface PlansGridProps {
  orgSlug: string;
  currentPlanSlug: string | null;
  /** Plans ordered cheapest-first (drives upgrade/downgrade relation). */
  plans: Plan[];
}

/** Derive the relation of a candidate plan to the currently subscribed one. */
function getPlanRelation(
  planSlug: string,
  currentPlanSlug: string | null,
  plans: Plan[],
): PlanRelation {
  if (planSlug === currentPlanSlug) return "current";
  if (!currentPlanSlug) return "switch";

  const currentIdx = plans.findIndex((p) => p.slug === currentPlanSlug);
  const candidateIdx = plans.findIndex((p) => p.slug === planSlug);

  if (currentIdx === -1 || candidateIdx === -1) return "switch";
  if (candidateIdx > currentIdx) return "upgrade";
  if (candidateIdx < currentIdx) return "downgrade";
  return "switch";
}

interface PendingPlanChange {
  slug: string;
  interval: "month" | "year";
  preview: PlanChangePreview;
}

export function PlansGrid({ orgSlug, currentPlanSlug, plans }: PlansGridProps) {
  const [pending, startTransition] = React.useTransition();
  const [interval, setInterval] = React.useState<"month" | "year">("month");
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [pendingChange, setPendingChange] = React.useState<PendingPlanChange | null>(null);
  const [confirmPending, startConfirmTransition] = React.useTransition();
  const { add: addToast } = useToast();

  const onSelect = (slug: string, chosenInterval: "month" | "year") => {
    if (slug === currentPlanSlug) return;
    setPreviewLoading(true);
    startTransition(async () => {
      const result = await previewPlanAction({ orgSlug, targetPlanSlug: slug, interval: chosenInterval });
      setPreviewLoading(false);

      if ("error" in result) {
        addToast({ title: "Could not preview plan change", description: result.error, type: "error" });
        return;
      }

      if (result.requiresCheckout) {
        // No subscription yet — go straight to Stripe Checkout.
        startConfirmTransition(async () => {
          const res = await changePlanAction({ orgSlug, targetPlanSlug: slug, interval: chosenInterval });
          if (!res.ok) {
            addToast({ title: "Plan change failed", description: res.error, type: "error" });
            return;
          }
          if (res.url) {
            window.location.href = res.url;
          }
        });
        return;
      }

      // Has subscription — show confirm dialog.
      setPendingChange({ slug, interval: chosenInterval, preview: result });
    });
  };

  function handleConfirm() {
    if (!pendingChange) return;
    const { slug, interval: chosenInterval } = pendingChange;
    startConfirmTransition(async () => {
      const res = await changePlanAction({ orgSlug, targetPlanSlug: slug, interval: chosenInterval });
      if (!res.ok) {
        addToast({ title: "Plan change failed", description: res.error, type: "error" });
        setPendingChange(null);
        return;
      }
      if (res.url) {
        window.location.href = res.url;
      } else {
        addToast({ title: "Plan updated", description: "Your plan has been changed.", type: "success" });
        setPendingChange(null);
      }
    });
  }

  const preview = pendingChange?.preview ?? null;

  return (
    <>
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
              relation={getPlanRelation(plan.slug, currentPlanSlug, plans)}
              onSelect={onSelect}
              pending={pending || previewLoading || confirmPending}
            />
          ))}
        </div>
      </section>

      {/* Plan-change confirmation dialog */}
      <Dialog open={!!pendingChange} onOpenChange={(open) => { if (!open) setPendingChange(null); }}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Confirm plan change</DialogTitle>
            <DialogDescription>
              Review the prorated charge before confirming.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {preview ? (
              <div className="space-y-3 text-sm">
                {preview.isCharge ? (
                  <p>
                    Switching to this plan will charge{" "}
                    <strong>{formatCents(preview.amountCents)}</strong> now to{" "}
                    {preview.card
                      ? <strong>{preview.card.brand} ••{preview.card.last4}</strong>
                      : "your card on file"
                    }
                    {" "}(prorated from{" "}
                    {new Date(preview.prorationDate).toLocaleDateString("en-US", { dateStyle: "medium" })}).
                  </p>
                ) : (
                  <p>
                    Switching to this plan will credit{" "}
                    <strong>{formatCents(preview.amountCents)}</strong> to your next invoice
                    (prorated from{" "}
                    {new Date(preview.prorationDate).toLocaleDateString("en-US", { dateStyle: "medium" })}).
                  </p>
                )}
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button onClick={handleConfirm} disabled={confirmPending}>
              {confirmPending ? "Processing…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
