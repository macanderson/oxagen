// The enforcement tier a run recorded (spec §8.4, ADR-095): where Oxagen
// observed the run's calls from. The vocabulary is closed and it is recorded
// once, so this renders the recorded word and never a stronger one. It never
// derives a tier from anything else on screen.
//
// Fleet and the Run header both draw it, from the same `RunRow.enforcementTier`
// through the same mapper, so the word a row carries and the word its run page
// carries cannot drift.
import { useTranslations } from "next-intl";
import type { EnforcementTier } from "@/data/contracts/runs";

export function EnforcementTierBadge({
  tier,
  testId,
}: {
  tier: EnforcementTier;
  /** Optional hook for a caller whose page already names this element. */
  testId?: string;
}) {
  const t = useTranslations("ui.enforcementTier");
  return (
    <span
      data-tier={tier}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground"
    >
      {t(tier)}
    </span>
  );
}
