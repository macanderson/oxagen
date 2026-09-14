import { CircleMinus, Lock, Pencil } from "lucide-react";
import { useTranslations } from "next-intl";
import type { SideEffect } from "@/data/contracts/common";
import { Chip } from "./chip";
import type { Tone } from "./tone";

export const EFFECT = {
  read: { tone: "neutral", icon: CircleMinus },
  write: { tone: "info", icon: Pencil },
  irreversible: { tone: "warning", icon: Lock },
} as const satisfies Record<SideEffect, { tone: Tone; icon: unknown }>;

export function EffectBadge({ effect }: { effect: SideEffect }) {
  const t = useTranslations("ui.effect");
  const { tone, icon } = EFFECT[effect];
  return (
    <Chip
      tone={tone}
      icon={icon}
      label={t(`${effect}.label`)}
      description={t(`${effect}.description`)}
      data-testid="effect-badge"
    />
  );
}
