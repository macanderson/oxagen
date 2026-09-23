// This month (pages/billing.md): what Stripe has invoiced in the current
// bucket month, one line per kind of charge — the plan, blocks bought through
// Checkout, auto top-ups, invoiced overage — then tax and the total. Every
// amount is a sum of invoice rows the Invoices section lists, so the table is
// a rollup of the rows beneath it, never a second figure. A kind with no
// invoice this month prints "none", not a zero it was not given. One of the
// files money renders in (INV-25).
import { PUBLISHED_TERMS } from "@oxagen/oxagen/contracts/billing.subscription_upgrade.start";
import { useLocale, useTranslations } from "next-intl";
import type {
  GauBucket,
  InvoicePage,
  InvoiceRow,
  PlanCard,
} from "@/data/contracts/billing";
import { type Money as MoneyValue, sumMoney } from "@/data/contracts/money";
import type { Read } from "@/data/read";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { cell, numericCell, Table } from "@/ui/table";
import { invoicesInMonth } from "./invoices-in-month";
import { BillingReadFailure } from "./read-failure";
import { Section } from "./section";

type Failed = Exclude<Read<unknown>, { ok: true }>;

const LINES: readonly {
  line: "plan" | "blocks" | "topups" | "overage";
  kinds: readonly InvoiceRow["kind"][];
}[] = [
  { line: "plan", kinds: ["subscription"] },
  { line: "blocks", kinds: ["gau_purchase"] },
  { line: "topups", kinds: ["gau_auto_topup"] },
  { line: "overage", kinds: ["gau_interim", "gau_period_close"] },
];

function Amount({ value }: { value: MoneyValue | null | undefined }) {
  const t = useTranslations("billing");
  if (value === undefined)
    return <span className="text-muted-foreground">{t("thisMonth.none")}</span>;
  if (value === null)
    return (
      <span data-recorded="false" className="text-muted-foreground">
        {t("thisMonth.mixedCurrency")}
      </span>
    );
  return <Money value={value} />;
}

export function ThisMonth({
  plan,
  bucket,
  invoices,
}: {
  plan: Read<PlanCard>;
  bucket: Read<GauBucket>;
  /** The newest invoices page, whatever page the Invoices section shows. */
  invoices: Read<InvoicePage>;
}) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const title = t("thisMonth.title");
  const failed = (read: Failed) => (
    <Section id="billing-this-month" title={title}>
      <BillingReadFailure read={read} section={title} />
    </Section>
  );
  if (!bucket.ok) return failed(bucket);
  if (!invoices.ok) return failed(invoices);
  const month = invoicesInMonth(invoices.value.items, bucket.value.period);
  if (month.length === 0) {
    return (
      <Section id="billing-this-month" title={title}>
        <p data-empty="" className="text-sm text-muted-foreground">
          {t("thisMonth.empty", {
            count: formatCount(PUBLISHED_TERMS.freeIncludedGauPerMonth, locale),
          })}
        </p>
      </Section>
    );
  }
  // The page reaches back no further than the newest page: when that page is
  // full of this month's invoices and has a next one, the month may go on.
  const oldest = invoices.value.items.at(-1);
  const partial =
    invoices.value.nextCursor !== null &&
    oldest !== undefined &&
    month.includes(oldest);
  const subscription = plan.ok ? plan.value.subscription : null;
  const planBasis =
    subscription === null
      ? t("thisMonth.basis.planNone")
      : t("thisMonth.basis.plan", {
          plan: subscription.plan,
          interval: t(`intervals.${subscription.billingInterval}`),
        });
  return (
    <Section id="billing-this-month" title={title}>
      <Table
        label={title}
        columns={[
          { label: t("thisMonth.columns.line") },
          { label: t("thisMonth.columns.basis") },
          { label: t("thisMonth.columns.amount"), numeric: true },
        ]}
      >
        {LINES.map(({ line, kinds }) => {
          const rows = month.filter((row) => kinds.includes(row.kind));
          return (
            <tr key={line} data-line={line}>
              <td className={cell}>{t(`thisMonth.lines.${line}`)}</td>
              <td className={`${cell} text-muted-foreground`}>
                {line === "plan"
                  ? planBasis
                  : t("thisMonth.basis.invoices", { count: rows.length })}
              </td>
              <td className={numericCell}>
                <Amount
                  value={
                    rows.length === 0
                      ? undefined
                      : sumMoney(rows.map((row) => row.amountDue))
                  }
                />
              </td>
            </tr>
          );
        })}
        <tr data-line="tax">
          <td className={cell}>{t("thisMonth.lines.tax")}</td>
          <td className={`${cell} text-muted-foreground`}>
            {t("thisMonth.basis.tax")}
          </td>
          <td className={`${numericCell} text-muted-foreground`}>
            {t("notRecorded")}
          </td>
        </tr>
        <tr data-line="total" className="font-semibold">
          <td className={cell}>{t("thisMonth.lines.total")}</td>
          <td className={`${cell} font-normal text-muted-foreground`}>
            {t("thisMonth.basis.total")}
          </td>
          <td className={numericCell}>
            <Amount value={sumMoney(month.map((row) => row.amountDue))} />
          </td>
        </tr>
      </Table>
      {partial ? (
        <p data-partial="" className="text-xs text-muted-foreground">
          {t("thisMonth.partial")}
        </p>
      ) : null}
    </Section>
  );
}
