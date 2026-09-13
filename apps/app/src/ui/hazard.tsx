// Hazard = the risk mark plus the side-effect glyph, drawn as bare glyphs with
// no chip so a registry row stays quiet. The filled octagon is reserved for
// critical. Colour is never alone: each glyph carries its word.
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Risk, SideEffect } from "@/data/contracts/common";
import { cx } from "./cx";
import { EFFECT } from "./effect-badge";
import { RISK } from "./risk-badge";
import { GLYPH_TONE, type Tone } from "./tone";

function Glyph({
  icon: Icon,
  tone,
  label,
  description,
  testId,
}: {
  icon: LucideIcon;
  tone: Tone;
  label: string;
  description: string;
  testId: string;
}) {
  return (
    <span
      title={description}
      data-testid={testId}
      data-tone={tone}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
    >
      <Icon
        aria-hidden
        focusable={false}
        strokeWidth={2}
        className={cx("size-3.5 shrink-0", GLYPH_TONE[tone])}
      />
      <span>{label}</span>
    </span>
  );
}

export function Hazard({ risk, effect }: { risk: Risk; effect?: SideEffect }) {
  const t = useTranslations("ui");
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <Glyph
        icon={RISK[risk].icon}
        tone={RISK[risk].tone}
        label={t(`risk.${risk}.label`)}
        description={t(`risk.${risk}.description`)}
        testId="hazard-risk"
      />
      {effect ? (
        <Glyph
          icon={EFFECT[effect].icon}
          tone={EFFECT[effect].tone}
          label={t(`effect.${effect}.label`)}
          description={t(`effect.${effect}.description`)}
          testId="hazard-effect"
        />
      ) : null}
    </span>
  );
}
