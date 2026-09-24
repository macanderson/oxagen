// The Library's Instructions shelf (roadmap pages/steering.md; the shelf body is
// pages/steering.md, which the steering-library lane builds). No read
// puts it into the one steering list yet, so the shelf names what is missing
// and draws nothing it cannot back.
import { useTranslations } from "next-intl";
import { STEERING_GAPS } from "../gaps";
import { NotBacked } from "../not-backed";

export function InstructionsShelf() {
  const t = useTranslations("steering.bodies.instructions");
  return (
    <div className="flex flex-col gap-4" data-testid="shelf-instructions">
      <NotBacked
        testId="instructions-not-backed"
        what={t("what")}
        issue={STEERING_GAPS.registry}
      />
    </div>
  );
}
