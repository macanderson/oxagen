import { useTranslations } from "next-intl";
import { getFormatter, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

const SECTIONS = { agents: {}, "run.frames_wrapped": {} };

export function Probe(props: {
  error: "a" | "b";
  section: keyof typeof SECTIONS;
}) {
  const t = useTranslations();
  const unrecorded = useTranslations("unrecorded");
  return (
    <p>
      {t("app.name")}
      {t(`errors.${props.error}`)}
      {unrecorded(props.section)}
    </p>
  );
}

export async function Panel() {
  const [panel, format] = await Promise.all([
    getTranslations("panel"),
    getFormatter(),
  ]);
  return (
    <p title={panel("title")}>
      {panel.rich("body", { b: (chunks: ReactNode) => <b>{chunks}</b> })}
      {format.dateTime(new Date())}
    </p>
  );
}
