// Governed action bucket (§1.4, §3.9 item 5): this month's included,
// purchased, carried-forward, used and remaining units, printed as stored — a
// negative remainder reads "overdrawn by N". A prepaid organization at or
// below zero with no saved payment method sees the Free-tier rule of
// 2026-09-14 (spec §4.2, ADR-055 §6): add a card, which the purchase form's
// Checkout saves, or wait for the allowance to renew. Counts only (INV-25).
import { useLocale, useTranslations } from "next-intl";
import type { GauBucket } from "@/data/contracts/billing";
import type { Read } from "@/data/read";
import { linkText } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { ReadFailure } from "./read-failure";
import { Fact, Facts, Section, useDate } from "./section";

export function BucketMeter({ bucket }: { bucket: Read<GauBucket> }) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const date = useDate();
  const title = t("bucket.title");
  if (!bucket.ok) {
    return (
      <Section id="billing-bucket" title={title}>
        <ReadFailure read={bucket} section={title} />
      </Section>
    );
  }
  const b = bucket.value;
  const gau = (count: number) =>
    t("units.gau", { count: formatCount(count, locale) });
  const exhaustedNoCard =
    b.autoTopup !== null &&
    b.autoTopup.paymentMethod === null &&
    b.remainingGau <= 0;
  return (
    <Section id="billing-bucket" title={title}>
      <Facts>
        <Fact name="period" term={t("bucket.period")}>
          {t("range", { start: date(b.period.start), end: date(b.period.end) })}
        </Fact>
        <Fact name="included" term={t("bucket.included")}>
          {gau(b.includedGau)}
        </Fact>
        <Fact name="purchased" term={t("bucket.purchased")}>
          {gau(b.purchasedGau)}
        </Fact>
        <Fact name="carried" term={t("bucket.carried")}>
          {gau(b.carriedGau)}
        </Fact>
        <Fact name="used" term={t("bucket.used")}>
          {gau(b.usedGau)}
        </Fact>
        <Fact name="remaining" term={t("bucket.remaining")}>
          {b.remainingGau < 0
            ? t("bucket.overdrawn", {
                count: formatCount(-b.remainingGau, locale),
              })
            : gau(b.remainingGau)}
        </Fact>
      </Facts>
      {exhaustedNoCard ? (
        <p data-exhausted="" className="text-sm font-medium text-foreground">
          {t.rich("bucket.exhaustedNoCard", {
            date: date(b.period.end),
            link: (chunks) => (
              <a href="#buy-governed-action-units" className={linkText}>
                {chunks}
              </a>
            ),
          })}
        </p>
      ) : null}
    </Section>
  );
}
