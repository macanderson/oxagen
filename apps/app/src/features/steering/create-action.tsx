// The Steering hub header's one gold action (roadmap pages/steering.md and
// creation-spec §1, the entry-point table): "Add a skill" on the Skills shelf,
// "Write a context record" everywhere else. Each opens its wizard over the
// page. The empty state carries the gold instead, so the header renders none
// there (./steering.tsx).
//
// A view whose body holds its own primary action takes the gold from the
// header (the design's `tabPrimary`): a selected Context PR whose checks
// passed, where Merge pull request is the gold, and the Skills shelf's Search
// and Versions views, whose submit buttons are. There the header button is
// drawn secondary, so the screen still carries exactly one gold.
import { useTranslations } from "next-intl";
import { CreateButton } from "@/ui/create-button";
import type { SteeringView } from "./view";

/** The Skills shelf's views whose body carries its own gold submit. */
const SKILL_VIEWS_WITH_PRIMARY: ReadonlySet<string> = new Set([
  "search",
  "versions",
]);

/**
 * Whether the view's body holds its own primary action. `mergeable` says the
 * selected Context PR's checks passed, which is when its Merge button is gold.
 */
export function tabHoldsPrimary(
  view: SteeringView,
  mergeable: boolean,
): boolean {
  if (view.tab === "proposals") {
    return view.segment === "prs" && view.proposal !== null && mergeable;
  }
  return (
    view.shelf === "skills" &&
    view.skillView !== undefined &&
    SKILL_VIEWS_WITH_PRIMARY.has(view.skillView)
  );
}

export function SteeringCreate({
  view,
  primary = true,
}: {
  view: Pick<SteeringView, "shelf">;
  /** False where the view's body carries the gold. */
  primary?: boolean;
}) {
  const t = useTranslations("steering.create");
  return view.shelf === "skills" ? (
    <CreateButton kind="skill" label={t("skill")} primary={primary} />
  ) : (
    <CreateButton kind="record" label={t("record")} primary={primary} />
  );
}
