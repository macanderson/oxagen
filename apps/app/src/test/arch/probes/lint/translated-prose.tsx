import { useTranslations } from "next-intl";

// Catalog prose, punctuation-only text and a computed attribute pass.
export function Probe({ label }: { label: string }) {
  const t = useTranslations("shell");
  return (
    <p aria-label={t("loading")} title={label}>
      {t("loading")} · …
    </p>
  );
}
