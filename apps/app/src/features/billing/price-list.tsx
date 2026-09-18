// The price list (pages/billing.md; maintainer decisions of 2026-09-14 and
// 2026-09-15): the published terms on both meters. Governed actions: Free,
// Build and Scale with their monthly allowance, Enterprise negotiated per
// contract, the list rate, the block and the volume bands. In-app AI usage:
// the credit's face value, how a model call is debited, the signup grant and
// the smallest credit pack. The figures come from the start_subscription_upgrade
// and purchase_credits contracts, which pricing.test.ts in @oxagen/billing
// holds equal to the schedule Stripe is synced from. One of the files money
// renders in (INV-25).
import { MIN_CREDIT_TOPUP_USD } from "@oxagen/oxagen/contracts/billing.credits.purchase";
import {
  PUBLISHED_TERMS,
  UPGRADE_PLANS,
} from "@oxagen/oxagen/contracts/billing.subscription_upgrade.start";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, type ReactNode } from "react";
import { type Money as MoneyValue, mulMicros } from "@/data/contracts/money";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { Section } from "./section";

const ONE_MICRO: MoneyValue = { micros: "1", currency: "USD" };
const ONE_CENT: MoneyValue = { micros: "10000", currency: "USD" };
const ONE_DOLLAR: MoneyValue = { micros: "1000000", currency: "USD" };

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
    <div
      data-price={name}
      className="flex items-baseline justify-between gap-4 py-1.5"
    >
      <dt className="text-sm text-foreground">{term}</dt>
      <dd className="text-right text-xs tabular-nums text-muted-foreground">
        {children}
      </dd>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </h3>
      <dl className="divide-y divide-border">{children}</dl>
    </div>
  );
}

export function PriceList() {
  const t = useTranslations("billing");
  const locale = useLocale();
  const count = (n: number) => formatCount(n, locale);
  const rate = mulMicros(ONE_MICRO, PUBLISHED_TERMS.ratePerGauMicros);
  return (
    <Section id="billing-price-list" title={t("priceList.title")}>
      <Group title={t("priceList.governed")}>
        <Price name="free" term={t("priceList.free")}>
          {t("priceList.freeTerms", {
            count: count(PUBLISHED_TERMS.freeIncludedGauPerMonth),
          })}
        </Price>
        {UPGRADE_PLANS.map((plan) => (
          <Price
            key={plan.slug}
            name={plan.tier}
            term={t(`tiers.${plan.tier}`)}
          >
            <Money value={mulMicros(ONE_CENT, plan.monthlyCents)} />{" "}
            {t("priceList.perMonth", {
              count: count(plan.includedGauPerMonth),
            })}
          </Price>
        ))}
        <Price name="enterprise" term={t("priceList.enterprise")}>
          {t("priceList.enterpriseTerms")}
        </Price>
        <Price name="list" term={t("priceList.list")}>
          <Money value={mulMicros(rate, 1000)} /> {t("priceList.perThousand")}
        </Price>
        <Price name="block" term={t("priceList.blocks")}>
          {t("priceList.blockTerms", {
            count: count(PUBLISHED_TERMS.blockSizeGau),
          })}{" "}
          <Money value={mulMicros(rate, PUBLISHED_TERMS.blockSizeGau)} />
        </Price>
        <Price name="bands" term={t("priceList.bands")}>
          {PUBLISHED_TERMS.volumeBandsUsdPer1000.map((usd, i) => (
            <Fragment key={usd}>
              {i === 0 ? null : " · "}
              <Money value={mulMicros(ONE_DOLLAR, usd)} />
            </Fragment>
          ))}
        </Price>
      </Group>
      <Group title={t("priceList.inApp")}>
        <Price name="credit" term={t("priceList.credit")}>
          {t("priceList.creditTerms")} <Money value={ONE_CENT} />
        </Price>
        <Price name="calls" term={t("priceList.calls")}>
          {t("priceList.callsTerms")}
        </Price>
        <Price name="grant" term={t("priceList.grant")}>
          <Money
            value={mulMicros(ONE_CENT, PUBLISHED_TERMS.signupGrantCredits)}
          />
        </Price>
        <Price name="packs" term={t("priceList.packs")}>
          {t("priceList.packsTerms")}{" "}
          <Money value={mulMicros(ONE_DOLLAR, MIN_CREDIT_TOPUP_USD)} />
        </Price>
      </Group>
      <p className="text-xs text-muted-foreground">
        {t("priceList.everyFeature")}
      </p>
    </Section>
  );
}
