// The price list (pages/billing.md): the seven published terms and the footer.
// Every figure is read, never typed here: the block size and the list rate
// come from PUBLISHED_TERMS in the start_subscription_upgrade contract, which
// pricing.test.ts in @oxagen/billing holds equal to the schedule Stripe is
// synced from; the retention window and its price come from
// get_evidence_retention. The Free row prints the signup grant (ADR-241,
// #3844): its size, its lifetime in days, and the evidence an account on it
// keeps, all from get_gau_bucket's read of the organization's own grant. An
// organization with no grant row prints "not recorded" for each. Enterprise
// is negotiated per organization and carries no published floor. One of the
// files money renders in (INV-25).
import { PUBLISHED_TERMS } from "@oxagen/oxagen/contracts/billing.subscription_upgrade.start";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { EvidenceRetention, GauBucket } from "@/data/contracts/billing";
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
        className={`${cell} w-5/12 text-left align-top text-sm font-normal`}
      >
        {term}
      </th>
      <td
        className={`${cell} text-right align-top font-mono text-xs tabular-nums text-muted-foreground`}
      >
        {children}
      </td>
    </tr>
  );
}

const DAY_MS = 86_400_000;

export function PriceList({
  retention,
  signupGrant,
}: {
  retention: EvidenceRetention;
  signupGrant: GauBucket["signupGrant"];
}) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const count = (n: number) => formatCount(n, locale);
  const title = t("priceList.title");
  const rate = mulMicros(ONE_MICRO, PUBLISHED_TERMS.ratePerGauMicros);
  return (
    <Section id="billing-price-list" title={title} flush>
      <table
        aria-label={title}
        className="w-full table-fixed border-collapse text-sm"
      >
        <tbody className="divide-y divide-border">
          <Price name="free" term={t("priceList.free")}>
            {signupGrant === null
              ? t.rich("priceList.freeTermsNotRecorded", {
                  nr: (chunks) => (
                    <NotRecordedValue>{chunks}</NotRecordedValue>
                  ),
                })
              : t("priceList.freeTerms", {
                  grant: count(signupGrant.grantedGau),
                  days: count(
                    Math.round(
                      (Date.parse(signupGrant.expiresAt) -
                        Date.parse(signupGrant.grantedAt)) /
                        DAY_MS,
                    ),
                  ),
                  evidence: count(signupGrant.evidenceDays),
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
            {t("priceList.enterpriseTerms")}
          </Price>
        </tbody>
      </table>
      <p
        className={`${panelBody} border-t border-border text-sm text-muted-foreground`}
      >
        {t("priceList.footer")}
      </p>
    </Section>
  );
}
