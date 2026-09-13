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
   * Optional callback invoked when the user clicks "Buy credits". Server
   * Components cannot pass a function across the boundary, so the billing page
   * leaves this unset and the banner falls back to scrolling the buy-credits
   * panel into view by DOM id — the same fallback `SubscriptionSummary` uses
   * for its "Change card" action. Pass it from a Client Component when you want
   * an explicit, testable dependency instead.
   */
  onBuyCredits?: () => void;
}

const SESSION_KEY_PREFIX = "oxagen:low-balance-dismissed:";

/** DOM id of the buy-credits panel on the billing subscription tab. */
const BUY_CREDITS_ANCHOR_ID = "buy-credits";

/**
 * Read the per-org dismiss flag. sessionStorage throws (not returns null) when
 * site data is blocked — a private window or a locked-down browser — and this
 * runs inside a render, so an unguarded read would take the whole billing page
 * down. Treat any failure as "not dismissed".
 */
function readDismissed(sessionKey: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(sessionKey) === "1";
  } catch {
    return false;
  }
}

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
  const [dismissed, setDismissed] = React.useState<boolean>(() =>
    readDismissed(sessionKey),
  );

  // Balance is fine — nothing to show.
  if (balanceCents >= thresholdCents) return null;

  // User dismissed for this session.
  if (dismissed) return null;

  function handleDismiss() {
    if (typeof window !== "undefined") {
      try {
        sessionStorage.setItem(sessionKey, "1");
      } catch {
        // Storage blocked — dismiss for this render only, don't crash.
      }
    }
    setDismissed(true);
  }

  function handleBuyCredits() {
    if (onBuyCredits) {
      onBuyCredits();
      return;
    }
    document
      .getElementById(BUY_CREDITS_ANCHOR_ID)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
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
              onClick={handleBuyCredits}
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
