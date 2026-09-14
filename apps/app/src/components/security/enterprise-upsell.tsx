// enterprise-upsell.tsx — the banner shown on SOC 2 / compliance surfaces when
// the org is below the Enterprise tier. The surface still renders (so the buyer
// can see the feature); this banner explains the gate and links to upgrade.
//
// Server Component — pure presentational. Pair it with disabled controls and a
// server-side assertEnterprise() check (see @/lib/enterprise) on any action.

import Link from "next/link";
import { Lock } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { org } from "@/lib/routes";
import { TIER_LABELS } from "@/lib/plan-label";
import type { PlanTier } from "@oxagen/oxagen/types";

export interface EnterpriseUpsellProps {
  orgSlug: string;
  /** Short feature name, e.g. "Audit log export" or "SIEM streaming". */
  feature: string;
  /** The org's current tier (for the "You're on X" copy). */
  currentTier: PlanTier;
}

export function EnterpriseUpsell({
  orgSlug,
  feature,
  currentTier,
}: EnterpriseUpsellProps) {
  return (
    <Alert variant="info">
      <Lock className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>{feature} is an Enterprise feature</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>
          {/* " plan" stays INSIDE the template literal — a bare JSX text-node
              space adjacent to an expression is not guaranteed to survive
              compilation, and losing it renders "Freeplan". */}
          You&rsquo;re on the {`${TIER_LABELS[currentTier]} plan`}. SOC&nbsp;2
          compliance tooling — exportable audit trails, evidence bundles, and
          SIEM streaming — unlocks on the Enterprise plan. Everything below is
          shown as a preview.
        </span>
        <Button
          variant="gradient"
          size="sm"
          className="shrink-0 self-start sm:self-auto"
          render={<Link href={org.billing.subscription({ orgSlug })} />}
        >
          Upgrade to Enterprise
        </Button>
      </AlertDescription>
    </Alert>
  );
}
