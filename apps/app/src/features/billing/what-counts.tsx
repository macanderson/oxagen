// What counts (pages/billing.md): which governed actions and model calls are
// billed, on which meter, and which are free or only reported. Copy only; the
// rules it states are metering's (spec §12.1, ADR-055, the 2026-09-15 two-meter
// decision), and nothing here reads a store.
import { useTranslations } from "next-intl";
import { Section } from "./section";

const ITEMS = ["gau", "credits", "free"] as const;

export function WhatCounts() {
  const t = useTranslations("billing.whatCounts");
  return (
    <Section id="billing-what-counts" title={t("title")}>
      <dl className="flex flex-col gap-3 text-sm">
        {ITEMS.map((item) => (
          <div key={item} data-counts={item} className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">{t(item)}</dt>
            <dd className="text-muted-foreground">{t(`${item}Body`)}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
