// Your contracted rate (§1.4, §3.9 item 3): the per-GAU rate at exact
// precision, the block price, the block size, the currency, the GAUs included
// each month, the effective dates and where the terms come from — a negotiated
// agreement or the published tier of the plan the organization is on, read
// live. The block size is carried as `data-block-size`, which the purchase
// form and the pay e2e read. One of the two places money renders (INV-25).
import { useLocale, useTranslations } from "next-intl";
import type { ContractRate } from "@/data/contracts/billing";
import type { Read } from "@/data/read";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { ReadFailure } from "./read-failure";
import { Fact, Facts, Section, useDate } from "./section";

export function ContractRateBlock({ rate }: { rate: Read<ContractRate> }) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const date = useDate();
  const title = t("rate.title");
  if (!rate.ok) {
    return (
      <Section id="billing-rate" title={title}>
        <ReadFailure read={rate} section={title} />
      </Section>
    );
  }
  const r = rate.value;
  const gau = (count: number) =>
    t("units.gau", { count: formatCount(count, locale) });
  let source: string;
  if (r.source === "published_tier")
    source = t("rate.published", { tier: t(`rate.tiers.${r.tier}`) });
  else if (r.agreementRef === null) source = t("rate.negotiatedNoRef");
  else source = t("rate.negotiated", { ref: r.agreementRef });
  return (
    <Section
      id="billing-rate"
      title={title}
      data-block-size={r.blockSizeGau}
      data-source={r.source}
    >
      <Facts>
        <Fact name="rate" term={t("rate.perGau")}>
          <Money value={r.ratePerGau} precision="exact" />
        </Fact>
        <Fact name="block-price" term={t("rate.perBlock")}>
          <Money value={r.blockPrice} />
        </Fact>
        <Fact name="block-size" term={t("rate.blockSize")}>
          {gau(r.blockSizeGau)}
        </Fact>
        <Fact name="currency" term={t("rate.currency")}>
          {r.ratePerGau.currency}
        </Fact>
        <Fact name="included" term={t("rate.included")}>
          {gau(r.includedGauPerMonth)}
        </Fact>
        <Fact name="effective" term={t("rate.effective")}>
          {r.effectiveTo === null
            ? t("rate.openEnded", { start: date(r.effectiveFrom) })
            : t("range", {
                start: date(r.effectiveFrom),
                end: date(r.effectiveTo),
              })}
        </Fact>
        <Fact name="source" term={t("rate.source")}>
          {source}
        </Fact>
      </Facts>
    </Section>
  );
}
