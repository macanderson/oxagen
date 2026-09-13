"use client";
// The enforcement tier a seam can earn (spec §3 "Enforcement tier"). A plain
// labelled chip: the word carries the meaning, never the colour alone.
// Promote: lane L2's TierBadge in src/ui replaces this.
import { useTranslations } from "next-intl";
import type { EnforcementTier } from "@/data/contracts/common";

const tone: Record<EnforcementTier, string> = {
  gateway: "border-success/50 bg-success/10",
  harness: "border-warning/60 bg-warning/10",
  observe: "border-border bg-muted",
};

export function TierBadge({ tier }: { tier: EnforcementTier }) {
  const t = useTranslations("onboarding.wrap");
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-xs text-foreground ${tone[tier]}`}
    >
      {t(`tiers.${tier}`)}
    </span>
  );
}
