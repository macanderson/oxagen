"use client";

import * as React from "react";
import { AlertTriangle, X } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/utils";

// ── LowBalanceBanner ──────────────────────────────────────────────────────────

export interface LowBalanceBannerProps {
  /** Org slug — used to derive a namespaced sessionStorage dismiss key. */
  orgSlug: string;
  /** Current credit balance in cents. */
  balanceCents: number;
  /** Threshold below which the banner is shown (in cents). */
  thresholdCents: number;
  /**
   * Optional callback invoked when the user clicks "Buy credits". The billing
   * page passes a handler that scrolls to / focuses the buy-credits widget.
   * Makes the dependency explicit and testable instead of relying on a DOM id.
   */
  onBuyCredits?: () => void;
}

const SESSION_KEY_PREFIX = "oxagen:low-balance-dismissed:";

/**
 * LowBalanceBanner — dismissible warning shown when the org's credit balance
 * is below the configured threshold.
 *
 * Dismiss state is stored in sessionStorage (vanishes on tab close) so the
 * user is reminded each new session. The banner is suppressed when balance is
 * healthy. When auto-reload is active the server should not pass a low balance
 * to this component, so we trust the page to not render it in that case.
 */
export function LowBalanceBanner({
  orgSlug,
  balanceCents,
  thresholdCents,
  onBuyCredits,
}: LowBalanceBannerProps) {
  const sessionKey = `${SESSION_KEY_PREFIX}${orgSlug}`;

  // Initialise dismissed state from sessionStorage (read once on mount).
  const [dismissed, setDismissed] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem(sessionKey) === "1";
  });

  // Balance is fine — nothing to show.
  if (balanceCents >= thresholdCents) return null;

  // User dismissed for this session.
  if (dismissed) return null;

  function handleDismiss() {
    if (typeof window !== "undefined") {
      sessionStorage.setItem(sessionKey, "1");
    }
    setDismissed(true);
  }

  return (
    <Alert variant="warning" className="relative">
      <AlertTriangle className="h-4 w-4" />
      <div className="flex items-start justify-between gap-4">
        <div>
          <AlertTitle>You&apos;re low on credits</AlertTitle>
          <AlertDescription>
            {formatCents(balanceCents)} remaining.{" "}
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-sm font-medium underline-offset-2"
              onClick={onBuyCredits}
            >
              Buy credits
            </Button>{" "}
            to keep your agents running.
          </AlertDescription>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleDismiss}
          aria-label="Dismiss low-balance warning"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </Alert>
  );
}
