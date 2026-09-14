import { CircleHelp, Eye, ShieldCheck, ShieldHalf } from "lucide-react";
import { useTranslations } from "next-intl";
import type { EnforcementTier } from "@/data/contracts/common";
import { Chip } from "./chip";
import type { Tone } from "./tone";

const TIER = {
  gateway: { tone: "success", icon: ShieldCheck },
  harness: { tone: "info", icon: ShieldHalf },
  observe: { tone: "neutral", icon: Eye },
} as const satisfies Record<EnforcementTier, { tone: Tone; icon: unknown }>;

/** The enforcement tier as recorded. `null` says "not recorded", never a tier it did not earn. */
export function TierBadge({ tier }: { tier: EnforcementTier | null }) {
  const t = useTranslations("ui.tier");
  if (tier === null)
    return (
      <Chip
        tone="neutral"
        icon={CircleHelp}
        dashed
        mono
        label={t("unknown.label")}
        description={t("unknown.description")}
        data-testid="tier-badge"
      />
    );
  const { tone, icon } = TIER[tier];
  return (
    <Chip
      tone={tone}
      icon={icon}
      mono
      label={t(`${tier}.label`)}
      description={t(`${tier}.description`)}
      data-testid="tier-badge"
    />
  );
}
