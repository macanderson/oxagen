// The Steering hub header's one gold action (roadmap pages/steering.md and
// creation-spec §1, the entry-point table): "Add a skill" on the Skills shelf,
// "Write a context record" everywhere else. Each opens its wizard over the
// page. The empty state carries the gold instead, so the header renders none
// there (./steering.tsx).
import { useTranslations } from "next-intl";
import { CreateButton } from "@/ui/create-button";
import type { SteeringView } from "./view";

export function SteeringCreate({ view }: { view: SteeringView }) {
  const t = useTranslations("steering.create");
  return view.shelf === "skills" ? (
    <CreateButton kind="skill" label={t("skill")} />
  ) : (
    <CreateButton kind="record" label={t("record")} />
  );
}
