// The enforcement tier a run recorded (spec §8.4, ADR-095): where Oxagen
// observed the run's calls from. The vocabulary is closed and it is recorded
// once, so this renders the recorded word and never a stronger one. It never
// derives a tier from anything else on screen.
//
// Fleet and the Run header both draw it, from the same `RunRow.enforcementTier`
// through the same mapper, so the word a row carries and the word its run page
// carries cannot drift. It is the mockup's `tierBadge`: `.b.b-tier` (mono,
// lowercase, no dot, because a tier is a fact and not a state) printing the
// tier's own word, tinted by how much of the run Oxagen stood in the path of,
// with the longer reading on hover.
import { useTranslations } from "next-intl";
import type { EnforcementTier } from "@/data/contracts/runs";
import { Badge, type BadgeTone } from "./badge";

/** `tierBadge`'s tint: `{ harness: approval, observe: q, gateway: allowed, contained: proven }`. */
const TONE: Record<EnforcementTier, BadgeTone> = {
  observe: "quiet",
  harness: "approval",
  gateway: "allowed",
  contained: "proven",
};

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
    <Badge
      tone={TONE[tier]}
      dot={false}
      mono
      title={t(tier)}
      data-tier={tier}
      data-testid={testId}
    >
      {tier}
    </Badge>
  );
}
