// Billing mode (§1.4, §3.9 item 6), read-only: prepaid, where governed actions
// stop at an empty bucket unless auto top-up refills it, or invoice billing,
// where usage is never capped and overage is invoiced at period end or once
// `gauMax` units accrue. Counts only.
import { useLocale, useTranslations } from "next-intl";
import type { GauBucket } from "@/data/contracts/billing";
import type { Read } from "@/data/read";
import { formatCount } from "@/ui/money-format";
import { ReadFailure } from "./read-failure";
import { Fact, Facts, Section } from "./section";

export function BillingMode({ bucket }: { bucket: Read<GauBucket> }) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const title = t("mode.title");
  if (!bucket.ok) {
    return (
      <Section id="billing-mode" title={title}>
        <ReadFailure read={bucket} section={title} />
      </Section>
    );
  }
  const { mode, invoice, autoTopup } = bucket.value;
  const gau = (count: number) =>
    t("units.gau", { count: formatCount(count, locale) });
  return (
    <Section id="billing-mode" title={title} data-mode={mode}>
      {invoice === null ? (
        <p className="text-sm text-foreground">
          {autoTopup?.paymentMethod === null
            ? t("mode.prepaidNoCard")
            : t("mode.prepaid")}
        </p>
      ) : (
        <>
          <p className="text-sm text-foreground">
            {t("mode.invoice", { max: formatCount(invoice.gauMax, locale) })}
          </p>
          <Facts>
            <Fact name="uninvoiced" term={t("mode.uninvoiced")}>
              {gau(invoice.uninvoicedGau)}
            </Fact>
            <Fact name="invoiced" term={t("mode.invoiced")}>
              {gau(invoice.invoicedThisPeriodGau)}
            </Fact>
          </Facts>
          {invoice.pastDue ? (
            <p data-past-due="" className="text-sm font-medium text-foreground">
              {t("mode.pastDue")}
            </p>
          ) : null}
        </>
      )}
    </Section>
  );
}
