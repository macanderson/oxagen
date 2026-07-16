"use client";
/**
 * BalancePill — always-visible remaining credit balance, shown in USD.
 *
 * Credits are the customer's currency (1 credit = 1¢), so the balance is shown
 * as dollars via the canonical formatCents helper. Lives in the shell header so
 * it's visible on every authenticated screen. Clicking it jumps to the billing
 * page to top up. When the balance is low it adopts a warning treatment — the
 * same threshold that drives the low-balance banner, so the two never disagree.
 */

import Link from "next/link";
import { Wallet } from "lucide-react";
import { formatCents, formatCentsCompact, formatCentsWhole, cn } from "@/lib/utils";

export interface BalancePillProps {
  orgSlug: string;
  balanceCents: number;
  /** True when the balance is below the org's low-balance threshold. */
  low?: boolean;
}

export function BalancePill({ orgSlug, balanceCents, low }: BalancePillProps) {
  return (
    <Link
      href={`/${orgSlug}/billing/subscription`}
      aria-label={`Remaining balance ${formatCents(balanceCents)}. Manage billing.`}
      title="Remaining balance — click to manage billing"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm font-medium tabular-nums transition-colors max-md:min-h-11",
        low
          ? "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20"
          : "border-border bg-muted/50 text-app-topbar-fg hover:bg-muted",
      )}
    >
      <Wallet className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
      {/* Visible label abbreviates a large balance ($12.3K) so the pill stays
          compact in the top bar; the aria-label above carries the exact figure
          for assistive tech. On phones the header has ~375px for five controls,
          so cents are dropped there ("$1,003") — the exact figure is one tap
          away on the billing page and always in the aria-label. */}
      <span className="max-sm:hidden">{formatCentsCompact(balanceCents)}</span>
      <span className="sm:hidden">{formatCentsWhole(balanceCents)}</span>
    </Link>
  );
}
