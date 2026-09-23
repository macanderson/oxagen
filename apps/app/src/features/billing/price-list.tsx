// The price list (pages/billing.md): the seven published terms and the footer.
// Every figure is read, never typed here: the free allowance, the block size
// and the list rate come from PUBLISHED_TERMS in the start_subscription_upgrade
// contract, which pricing.test.ts in @oxagen/billing holds equal to the
// schedule Stripe is synced from; the retention window and its price come from
// get_evidence_retention. A figure the record does not carry (the seats and
// evidence days of the free tier, a floor price for Enterprise) is left out
// rather than written in. One of the files money renders in (INV-25).
import { PUBLISHED_TERMS } from "@oxagen/oxagen/contracts/billing.subscription_upgrade.start";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { EvidenceRetention } from "@/data/contracts/billing";
import { type Money as MoneyValue, mulMicros } from "@/data/contracts/money";
import type { Read } from "@/data/read";
import { panelBody } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { cell, numericCell } from "@/ui/table";
import { BillingReadFailure } from "./read-failure";
import { Section } from "./section";

const ONE_MICRO: MoneyValue = { micros: "1", currency: "USD" };

function Price({
  name,
  term,
  children,
}: {
  name: string;
  term: string;
  children: ReactNode;
}) {
  return (
    <tr data-price={name}>
      <th scope="row" className={`${cell} text-left text-[12.5px] font-normal`}>
        {term}
      </th>
      <td className={`${numericCell} whitespace-normal text-[11.5px]`}>
        {children}
      </td>
    </tr>
  );
}

export function PriceList({
  retention,
}: {
  retention: Read<EvidenceRetention>;
}) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const count = (n: number) => formatCount(n, locale);
  const title = t("priceList.title");
  const rate = mulMicros(ONE_MICRO, PUBLISHED_TERMS.ratePerGauMicros);
  return (
    <Section id="billing-price-list" title={title} flush>
      <table aria-label={title} className="w-full border-collapse text-[13px]">
        <tbody className="divide-y divide-border">
          <Price name="free" term={t("priceList.free")}>
            {t("priceList.freeTerms", {
              count: count(PUBLISHED_TERMS.freeIncludedGauPerMonth),
            })}
          </Price>
          <Price
            name="blocks"
            term={t("priceList.blocks", {
              count: count(PUBLISHED_TERMS.blockSizeGau),
            })}
          >
            {t.rich("priceList.blocksTerms", {
              price: () => (
                <Money value={mulMicros(rate, PUBLISHED_TERMS.blockSizeGau)} />
              ),
            })}
          </Price>
          <Price name="negotiated" term={t("priceList.negotiated")}>
            {t("priceList.negotiatedTerms")}
          </Price>
          <Price name="invoice" term={t("priceList.invoice")}>
            {t("priceList.invoiceTerms")}
          </Price>
          <Price name="retention" term={t("priceList.retention")}>
            {retention.ok ? (
              t.rich("priceList.retentionTerms", {
                months: count(retention.value.includedMonths),
                price: () => (
                  <Money value={retention.value.perGbMonth} precision="exact" />
                ),
              })
            ) : (
              <BillingReadFailure
                read={retention}
                section={t("priceList.retention")}
              />
            )}
          </Price>
          <Price name="tokens" term={t("priceList.tokens")}>
            {t("priceList.tokensTerms")}
          </Price>
          <Price name="enterprise" term={t("priceList.enterprise")}>
            {t("priceList.enterpriseTerms")}
          </Price>
        </tbody>
      </table>
      <p
        className={`${panelBody} border-t border-border text-xs text-muted-foreground`}
      >
        {t("priceList.footer")}
      </p>
    </Section>
  );
}
