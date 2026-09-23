// The Library's Ontology shelf (roadmap pages/steering.md; the shelf body is
// pages/steering-ontology.md, which the steering-library lane builds). No read
// puts it into the one steering list yet, so the shelf names what is missing
// and draws nothing it cannot back.
import { useTranslations } from "next-intl";
import { STEERING_GAPS } from "../gaps";
import { NotBacked } from "../not-backed";

export function OntologyShelf() {
  const t = useTranslations("steering.bodies.ontology");
  return (
    <div className="flex flex-col gap-4" data-testid="shelf-ontology">
      <NotBacked
        testId="ontology-not-backed"
        what={t("what")}
        issue={STEERING_GAPS.registry}
      />
    </div>
  );
}
