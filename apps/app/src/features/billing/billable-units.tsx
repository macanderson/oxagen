// Billable units (pages/billing.md): what is priced, what is only reported,
// and what is free, as the design's chain of three. Copy only; the rules it
// states are metering's (spec §12.1 as amended by ADR-055), and nothing here
// reads a store.
import { useTranslations } from "next-intl";
import { Section } from "./section";

const UNITS = ["priced", "reported", "free"] as const;

export function BillableUnits() {
  const t = useTranslations("billing.billableUnits");
  return (
    <Section id="billing-billable-units" title={t("title")}>
      <ol className="flex flex-col gap-4">
        {UNITS.map((unit) => (
          <li
            key={unit}
            data-unit={unit}
            className="relative flex flex-col gap-1 pl-6 before:absolute before:left-1 before:top-1.5 before:size-2 before:rounded-full before:bg-gold"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim">
              {t(unit)}
            </span>
            <span className="text-sm text-foreground">{t(`${unit}Body`)}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
