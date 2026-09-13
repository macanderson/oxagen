"use client";
/**
 * PostureBadgeGroup — shared provider-capability-posture badge cluster.
 *
 * Renders the @oxagen/ai/posture projection (see that module for the "why":
 * a real defect where Anthropic's prompt cache silently ran at 0% hit rate
 * because nothing enforced the vendor's opt-in-vs-implicit divergence).
 * Shared between the two model-picking surfaces in the app — model-picker's
 * dense "Other models" row list (attached per model) and ProviderModelPicker's
 * cascading Provider→Model selects (attached per vendor, once chosen) — so
 * the badge styling, tooltip wiring, and "unknown vendor" fallback live in
 * exactly one place instead of drifting between the two.
 *
 * Kept restrained on purpose: a dense picker showing all four axes on every
 * row/option would drown the list. Only the `requiresAction` badges — the
 * ones a caller must actively handle, e.g. an opt-in cache nobody opted into,
 * or emulated structured output that can come back malformed — render
 * inline. The full four-axis breakdown, passive axes included, is one hover
 * away via the tooltip. `requiresAction` chips are visually distinguished
 * from passive ones on three independent signals (variant color, a leading
 * AlertTriangle icon, and their own label text), never color alone. A vendor
 * the posture registry has never seen renders an explicit "Posture: unknown"
 * badge — never a fabricated "supported" claim.
 */
import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  postureBadges,
  type PostureBadge,
  type VendorPosture,
} from "@oxagen/ai/posture";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipPopup } from "@/components/ui/tooltip";

/** One posture badge as a chip. */
function PostureChip({
  badge,
  className,
}: {
  badge: PostureBadge;
  className?: string;
}) {
  return (
    <Badge
      variant={badge.requiresAction ? "warning-soft" : "muted"}
      size="sm"
      title={badge.detail}
      className={cn("w-fit gap-1", className)}
    >
      {badge.requiresAction && (
        <AlertTriangle aria-hidden="true" className="h-2.5 w-2.5" />
      )}
      {badge.label}
    </Badge>
  );
}

export interface PostureBadgeGroupProps {
  /** The resolved posture, or undefined when the registry has no row for
   * this vendor (an id/vendor the posture matrix has never seen). */
  posture: VendorPosture | undefined;
  /** Human vendor label, for the tooltip heading and the aria-label. */
  vendorLabel: string;
  className?: string;
}

/**
 * The posture badge cluster for one vendor. Renders an explicit
 * "Posture: unknown" chip — never a fabricated "supported" badge — when
 * `posture` is undefined.
 */
export function PostureBadgeGroup({
  posture,
  vendorLabel,
  className,
}: PostureBadgeGroupProps) {
  if (!posture) {
    return (
      <span className={cn("flex items-center", className)}>
        <Badge
          variant="muted"
          size="sm"
          title="Oxagen has not recorded a capability posture for this vendor yet — cache, reasoning, structured-output, and attachment behavior are unverified. Treat none of them as supported."
          className="w-fit"
        >
          Posture: unknown
        </Badge>
      </span>
    );
  }

  const badges = postureBadges(posture);
  const actionBadges = badges.filter((b) => b.requiresAction);
  const summary = badges.map((b) => `${b.label} — ${b.detail}`).join(". ");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("flex flex-wrap items-center gap-1", className)}
            role="group"
            aria-label={`${vendorLabel} capability posture. ${summary}`}
          />
        }
      >
        {actionBadges.map((b) => (
          <PostureChip key={b.axis} badge={b} />
        ))}
        {/* Always-present low-emphasis affordance so the full four-axis
            breakdown is discoverable even when nothing needs action. */}
        <span
          aria-hidden="true"
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border text-[9px] leading-none text-muted-foreground"
        >
          i
        </span>
      </TooltipTrigger>
      <TooltipPopup align="start" className="max-w-[260px]">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">
            {vendorLabel} capability posture
          </span>
          {badges.map((b) => (
            <div key={b.axis} className="flex flex-col gap-0.5">
              <PostureChip badge={b} />
              <span className="text-[11px] leading-snug text-muted-foreground">
                {b.detail}
              </span>
            </div>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
