// The enforcement tier a run recorded (spec §8.4, ADR-095): where Oxagen
// observed the run's calls from. The vocabulary is closed and it is recorded
// once, so this renders the recorded word and never a stronger one. It never
// derives a tier from anything else on screen.
//
// Fleet and the Run header both draw it, from the same `RunRow.enforcementTier`
// through the same mapper, so the word a row carries and the word its run page
// carries cannot drift. It is the mockup's `.b.b-tier`: the quiet pill, mono
// and lowercase, with no dot, because a tier is a fact and not a state.
import { useTranslations } from "next-intl";
import type { EnforcementTier } from "@/data/contracts/runs";
import { Badge } from "./badge";

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
    <Badge tone="quiet" dot={false} mono data-tier={tier} data-testid={testId}>
      {t(tier)}
    </Badge>
  );
}
