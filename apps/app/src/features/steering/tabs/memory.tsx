// The Library's Memory shelf (roadmap pages/steering.md; the shelf body is
// pages/steering-memory.md, which the steering-library lane builds). No read
// puts it into the one steering list yet, so the shelf names what is missing
// and draws nothing it cannot back.
import { useTranslations } from "next-intl";
import { STEERING_GAPS } from "../gaps";
import { NotBacked } from "../not-backed";

export function MemoryShelf() {
  const t = useTranslations("steering.bodies.memory");
  return (
    <div className="flex flex-col gap-4" data-testid="shelf-memory">
      <NotBacked
        testId="memory-not-backed"
        what={t("what")}
        issue={STEERING_GAPS.registry}
      />
    </div>
  );
}
