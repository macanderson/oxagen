import { useTranslations } from "next-intl";

export function Probe({ label }: { label: string }) {
  const t = useTranslations("app");
  return <p>{t(label)}</p>;
}

export function Computed({ ns }: { ns: string }) {
  const t = useTranslations(ns);
  return <p>{t("name")}</p>;
}
