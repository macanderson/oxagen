// The price list (pages/billing.md): the seven published terms and the footer.
// Every figure is read, never typed here: the block size and the list rate
// come from PUBLISHED_TERMS in the start_subscription_upgrade contract, which
// pricing.test.ts in @oxagen/billing holds equal to the schedule Stripe is
// synced from; the retention window and its price come from
// get_evidence_retention. The Free row is the design's wording, "an included
// monthly allowance" with no figure. The free tier's evidence days and seats
// have no published term yet (#3844), so each says "not recorded" in its
// place. A floor price for Enterprise has none either and is left out. One of
// the files money renders in (INV-25).
import { PUBLISHED_TERMS } from "@oxagen/oxagen/contracts/billing.subscription_upgrade.start";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { EvidenceRetention } from "@/data/contracts/billing";
import { type Money as MoneyValue, mulMicros } from "@/data/contracts/money";
import { panelBody } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { cell } from "@/ui/table";
import { NotRecordedValue, Section } from "./section";

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
      <th
        scope="row"
        className={`${cell} w-[42%] text-left align-top text-[12.5px] font-normal`}
      >
        {term}
      </th>
      <td
        className={`${cell} text-right align-top font-mono text-[11.5px] tabular-nums text-muted-foreground`}
      >
        {children}
      </td>
    </tr>
  );
}

export function PriceList({ retention }: { retention: EvidenceRetention }) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const count = (n: number) => formatCount(n, locale);
  const title = t("priceList.title");
  const rate = mulMicros(ONE_MICRO, PUBLISHED_TERMS.ratePerGauMicros);
  return (
    <Section id="billing-price-list" title={title} flush>
      <table
        aria-label={title}
        className="w-full table-fixed border-collapse text-[13px]"
      >
        <tbody className="divide-y divide-border">
          <Price name="free" term={t("priceList.free")}>
            {t.rich("priceList.freeTerms", {
              nr: (chunks) => <NotRecordedValue>{chunks}</NotRecordedValue>,
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
            {t.rich("priceList.retentionTerms", {
              months: count(retention.includedMonths),
              price: () => (
                <Money value={retention.perGbMonth} precision="exact" />
              ),
            })}
          </Price>
          <Price name="tokens" term={t("priceList.tokens")}>
            {t("priceList.tokensTerms")}
          </Price>
          <Price name="enterprise" term={t("priceList.enterprise")}>
            {t.rich("priceList.enterpriseTerms", {
              nr: (chunks) => <NotRecordedValue>{chunks}</NotRecordedValue>,
            })}
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
