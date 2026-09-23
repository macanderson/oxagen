// The Steering hub header's one gold action (roadmap creation-spec §1, the
// entry-point table): "Add a skill" on the Skills tab, "Write a context
// record" on every other tab. Each opens its wizard over the page.
import { useTranslations } from "next-intl";
import { CreateButton } from "@/ui/create-button";
import { parseSteeringView } from "./view";

export function SteeringCreate({
  searchParams,
}: {
  searchParams: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const t = useTranslations("steering.create");
  const view = parseSteeringView(searchParams);
  return view.tab === "library" && view.shelf === "skills" ? (
    <CreateButton kind="skill" label={t("skill")} />
  ) : (
    <CreateButton kind="record" label={t("record")} />
  );
}
