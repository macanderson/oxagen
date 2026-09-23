// Meters (pages/billing.md): the two meters Oxagen charges on and the figures
// it reports beside them. Governed action units are used against this month's
// bucket (included + purchased + carried), printed as stored — a negative
// remainder reads "overdrawn by N". Other governed actions are reported and
// never priced; nothing records them yet, so they print "not recorded"
// rather than a zero. Usage credits are the in-app AI usage balance,
// printed as a count. Under the table: the billing mode (prepaid or invoice),
// and the Free-tier rule for a prepaid organization at zero with no card
// (spec §4.2, ADR-055 §6). Counts only; no money renders here (INV-25).
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { GauBucket, UsageCredits } from "@/data/contracts/billing";
import type { Read } from "@/data/read";
import { linkText } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { cell, Table } from "@/ui/table";
import { BillingReadFailure } from "./read-failure";
import { Section, useDate } from "./section";

function Row({
  name,
  meter,
  value,
  note,
}: {
  name: string;
  meter: string;
  value: ReactNode;
  note: ReactNode;
}) {
  return (
    <tr data-meter={name}>
      <td className={cell}>{meter}</td>
      <td className={`${cell} tabular-nums`}>{value}</td>
      <td className={`${cell} text-xs text-muted-foreground`}>{note}</td>
    </tr>
  );
}

function Mode({ bucket }: { bucket: GauBucket }) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const gau = (count: number) =>
    t("units.gau", { count: formatCount(count, locale) });
  const { invoice, autoTopup } = bucket;
  if (invoice === null) {
    return (
      <p data-mode="prepaid" className="text-sm text-muted-foreground">
        {autoTopup?.paymentMethod === null
          ? t("mode.prepaidNoCard")
          : t("mode.prepaid")}
      </p>
    );
  }
  return (
    <div data-mode="invoice" className="flex flex-col gap-1 text-sm">
      <p className="text-muted-foreground">
        {t("mode.invoice", { max: formatCount(invoice.gauMax, locale) })}
      </p>
      <p data-fact="uninvoiced" className="text-muted-foreground">
        {t("mode.uninvoiced")}: {gau(invoice.uninvoicedGau)} ·{" "}
        {t("mode.invoiced")}: {gau(invoice.invoicedThisPeriodGau)}
      </p>
      {invoice.pastDue ? (
        <p data-past-due="" className="font-medium text-foreground">
          {t("mode.pastDue")}
        </p>
      ) : null}
    </div>
  );
}

export function Meters({
  bucket,
  credits,
}: {
  bucket: Read<GauBucket>;
  credits: Read<UsageCredits>;
}) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const date = useDate();
  const title = t("meters.title");
  const count = (n: number) => formatCount(n, locale);
  const notRecorded = (
    <span data-recorded="false" className="text-muted-foreground">
      {t("notRecorded")}
    </span>
  );
  const b = bucket.ok ? bucket.value : null;
  let gauValue: ReactNode;
  let gauNote: ReactNode = null;
  if (!bucket.ok) {
    gauValue = <BillingReadFailure read={bucket} section={t("meters.gau")} />;
  } else {
    const v = bucket.value;
    gauValue = t("meters.gauValue", {
      used: count(v.usedGau),
      total: count(v.includedGau + v.purchasedGau + v.carriedGau),
    });
    gauNote = t("meters.gauNote", {
      period: t("range", {
        start: date(v.period.start),
        end: date(v.period.end),
      }),
      remaining:
        v.remainingGau < 0
          ? t("meters.overdrawn", { count: count(-v.remainingGau) })
          : t("meters.remaining", { count: count(v.remainingGau) }),
    });
  }
  // A prepaid organization at or below zero with no saved card: the Free-tier
  // rule of 2026-09-14 (spec §4.2, ADR-055 §6).
  const exhausted =
    b !== null &&
    b.autoTopup !== null &&
    b.autoTopup.paymentMethod === null &&
    b.remainingGau <= 0
      ? b
      : null;
  return (
    <Section id="billing-meters" title={title}>
      <Table
        label={title}
        columns={[
          { label: t("meters.columns.meter") },
          { label: t("meters.columns.thisMonth") },
          { label: t("meters.columns.note") },
        ]}
      >
        <Row
          name="gau"
          meter={t("meters.gau")}
          value={gauValue}
          note={gauNote}
        />
        <Row
          name="other"
          meter={t("meters.other")}
          value={notRecorded}
          note={t("meters.otherNote")}
        />
        <Row
          name="credits"
          meter={t("meters.credits")}
          value={
            credits.ok ? (
              t("meters.creditsValue", {
                count: count(credits.value.balanceCredits),
              })
            ) : (
              <BillingReadFailure
                read={credits}
                section={t("meters.credits")}
              />
            )
          }
          note={t("meters.creditsNote")}
        />
      </Table>
      {b === null ? null : <Mode bucket={b} />}
      {exhausted === null ? null : (
        <p data-exhausted="" className="text-sm font-medium text-foreground">
          {t.rich("meters.exhaustedNoCard", {
            date: date(exhausted.period.end),
            link: (chunks) => (
              <a href="#buy-governed-action-units" className={linkText}>
                {chunks}
              </a>
            ),
          })}
        </p>
      )}
    </Section>
  );
}
