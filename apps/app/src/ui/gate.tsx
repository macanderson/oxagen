import { BadgeDollarSign, Ban, Check, Power, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Chip } from "./chip";
import type { Tone } from "./tone";
import type { GateDecision } from "./vocabulary";

// Dashed = a person still stands in the way.
const GATE = {
  allow: { tone: "success", icon: Check, dashed: false },
  require_approval: { tone: "info", icon: ShieldAlert, dashed: true },
  mandate: { tone: "info", icon: BadgeDollarSign, dashed: true },
  deny: { tone: "warning", icon: Ban, dashed: false },
  killed: { tone: "critical", icon: Power, dashed: false },
} as const satisfies Record<
  GateDecision,
  { tone: Tone; icon: unknown; dashed: boolean }
>;

export type GateProps = {
  gate: GateDecision;
  /** Why this gate holds (policy version, rule id, who flipped the switch). Replaces the generic description. */
  note?: string;
};

export function Gate({ gate, note }: GateProps) {
  const t = useTranslations("ui.gate");
  const { tone, icon, dashed } = GATE[gate];
  return (
    <Chip
      tone={tone}
      icon={icon}
      dashed={dashed}
      label={t(`${gate}.label`)}
      description={note ?? t(`${gate}.description`)}
      data-testid="gate"
    />
  );
}
