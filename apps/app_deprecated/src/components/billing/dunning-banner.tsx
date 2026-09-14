"use client";

import * as React from "react";
import { AlertTriangle, Ban } from "lucide-react";
import type { OrgBillingStatus } from "@oxagen/billing";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

// ── DunningBanner ─────────────────────────────────────────────────────────────

export interface DunningBannerProps {
  /** Org slug — reserved for future org-scoped action routing. */
  orgSlug: string;
  /** Billing status object from `getOrgBillingStatus`. */
  status: OrgBillingStatus;
}

/**
 * DunningBanner — surfaces payment failure and account suspension states.
 *
 * Renders nothing for active accounts. Grace-period accounts see a warning
 * with a deadline. Suspended accounts see a destructive block and are directed
 * to fix their payment method to restore access.
 */
export function DunningBanner({ status }: DunningBannerProps) {
  if (status.state === "active") return null;

  function scrollToPaymentMethods() {
    const el = document.getElementById("payment-methods");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      const focusable = el.querySelector<HTMLElement>(
        "button, input, select, textarea, [tabindex]",
      );
      focusable?.focus();
    }
  }

  if (status.state === "grace") {
    return (
      <Alert variant="warning">
        <AlertTriangle className="h-4 w-4" />
        <div className="flex flex-col gap-1.5">
          <AlertTitle>Your last payment failed</AlertTitle>
          <AlertDescription>
            Update your payment method by{" "}
            <strong>{formatDate(status.graceEndsAt)}</strong> to avoid service
            interruption.
          </AlertDescription>
          <div className="mt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={scrollToPaymentMethods}
            >
              Update payment method
            </Button>
          </div>
        </div>
      </Alert>
    );
  }

  // state === "suspended"
  return (
    <Alert variant="error">
      <Ban className="h-4 w-4" />
      <div className="flex flex-col gap-1.5">
        <AlertTitle>Your account is suspended</AlertTitle>
        <AlertDescription>
          Access has been suspended due to non-payment. Update your payment
          method to restore access.
        </AlertDescription>
        <div className="mt-1">
          <Button
            size="sm"
            variant="destructive"
            onClick={scrollToPaymentMethods}
          >
            Update payment method
          </Button>
        </div>
      </div>
    </Alert>
  );
}
