/**
 * seat-alert.ts — pure helper that maps OrgSeatUsage to a UI alert descriptor.
 *
 * Kept as a pure function (no side effects, no imports from next/react) so it
 * can be tested in isolation with vitest and reused in both the members RSC and
 * any future surface.
 */

import type { OrgSeatUsage } from "@oxagen/billing";

export type SeatAlertVariant = "error" | "warning" | "success";

export interface SeatAlert {
  variant: SeatAlertVariant;
  title: string;
  body: string;
  /** When set, the CTA should link to this href. */
  cta?: { label: string; href: string };
}

/**
 * Derive a seat-state alert from the current org seat usage.
 *
 * States (in priority order):
 *   1. over-provisioned  (used > licenses) → error
 *   2. at limit, free/single-license       → warning + billing link
 *   3. seats available                      → success
 */
export function seatAlert(usage: OrgSeatUsage, orgSlug: string): SeatAlert {
  const { licenses, used, available } = usage;

  // Error: more members than licenses (should not happen under normal flow,
  // but possible after a downgrade or manual DB change).
  if (used > licenses) {
    return {
      variant: "error",
      title: "You have more members than licenses",
      body: `Your org has ${used} members but only ${licenses} license${licenses === 1 ? "" : "s"}. Remove members or add more licenses to resolve this.`,
      cta: { label: "Manage licenses", href: `/${orgSlug}/billing/subscription` },
    };
  }

  // Warning: no available seats (free plan = 1 license, or any plan at capacity).
  if (available <= 0) {
    const isSingleLicense = licenses <= 1;
    return {
      variant: "warning",
      title: isSingleLicense
        ? "You have 1 user license"
        : `All ${licenses} licenses are in use`,
      body: isSingleLicense
        ? "Increase your licenses on Billing to invite teammates."
        : `You are using all ${licenses} licenses. Add more seats to invite additional teammates.`,
      cta: { label: "Increase licenses", href: `/${orgSlug}/billing/subscription` },
    };
  }

  // Success: seats available.
  return {
    variant: "success",
    title: `${available} license${available === 1 ? "" : "s"} available`,
    body:
      available === 1
        ? "You have 1 unused license — invite a teammate."
        : `You have ${available} unused licenses — invite more teammates.`,
  };
}
