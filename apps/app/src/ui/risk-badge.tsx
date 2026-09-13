import { Circle, Diamond, OctagonAlert, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Risk } from "@/data/contracts/common";
import { Chip } from "./chip";
import type { Tone } from "./tone";

export const RISK = {
  low: { tone: "neutral", icon: Circle },
  medium: { tone: "info", icon: Diamond },
  high: { tone: "warning", icon: TriangleAlert },
  critical: { tone: "critical", icon: OctagonAlert },
} as const satisfies Record<Risk, { tone: Tone; icon: unknown }>;

export function RiskBadge({ risk }: { risk: Risk }) {
  const t = useTranslations("ui.risk");
  const { tone, icon } = RISK[risk];
  return (
    <Chip
      tone={tone}
      icon={icon}
      label={t(`${risk}.label`)}
      description={t(`${risk}.description`)}
      data-testid="risk-badge"
    />
  );
}
