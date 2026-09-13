import {
  BadgeCheck,
  CircleAlert,
  CircleHelp,
  CircleX,
  Flag,
  Minus,
  ShieldX,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { Verdict } from "@/data/contracts/common";
import { Chip } from "./chip";
import type { Tone } from "./tone";

const VERDICT = {
  flipped: { tone: "success", icon: BadgeCheck },
  failing: { tone: "error", icon: CircleX },
  unmoved: { tone: "neutral", icon: Minus },
  unsatisfied: { tone: "warning", icon: CircleAlert },
  tampered: { tone: "critical", icon: ShieldX },
  unverified: { tone: "neutral", icon: CircleHelp },
  waived: { tone: "neutral", icon: Flag },
  none: { tone: "neutral", icon: Minus },
} as const satisfies Record<Verdict, { tone: Tone; icon: unknown }>;

export type VerdictBadgeProps = {
  verdict: Verdict;
  /** A flipped verdict with a recorded flip shows the fail → pass flourish. */
  flip?: boolean;
};

export function VerdictBadge({ verdict, flip = false }: VerdictBadgeProps) {
  const t = useTranslations("ui.verdict");
  const { tone, icon } = VERDICT[verdict];
  return (
    <Chip
      tone={tone}
      icon={icon}
      dashed={verdict === "none"}
      label={t(`${verdict}.label`)}
      description={t(`${verdict}.description`)}
      data-testid="verdict-badge"
      suffix={
        verdict === "flipped" && flip ? (
          <span className="font-mono text-[10.5px] text-muted-foreground">
            {t("flip")}
          </span>
        ) : null
      }
    />
  );
}
