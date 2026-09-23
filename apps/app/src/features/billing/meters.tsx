// Meters (pages/billing.md): the one priced meter and the meters reported
// beside it. Governed actions lead: the count used this period against the
// bucket, the billable unit. Sealed runs with a model call, runs Oxagen halted
// before any model call and runs of the in-app agent have no read in this
// release (the cost.run_totals rollup, spec §12.6), so each prints "not
// recorded" rather than a zero. Retained evidence has no volume on record
// either (get_evidence_retention carries only the volume beyond the included
// window, unmeasured), so it too says "not recorded", with the included
// window beside it. Under the table: the note the design gives, the billing mode
// (prepaid or invoice), and the Free-tier rule for a prepaid organization at
// zero with no card (spec §4.2, ADR-055 §6). Counts only; no money renders
// here (INV-25).
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { EvidenceRetention, GauBucket } from "@/data/contracts/billing";
import type { Read } from "@/data/read";
import { linkText, panelBody } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { cell, numericCell, Table } from "@/ui/table";
import { BillingReadFailure } from "./read-failure";
import { NotRecordedValue, PanelNote, Section, useDate } from "./section";

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
      <td className={numericCell}>{value}</td>
      <td className={`${cell} text-[11.5px] text-muted-foreground`}>{note}</td>
    </tr>
  );
}

function Mode({ bucket }: { bucket: GauBucket }) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const governed = (count: number) =>
    t("units.governed", { count: formatCount(count, locale) });
  const { invoice, autoTopup } = bucket;
  if (invoice === null) {
    return (
      <p data-mode="prepaid" className="text-[12.5px] text-muted-foreground">
        {autoTopup?.paymentMethod === null
          ? t("mode.prepaidNoCard")
          : t("mode.prepaid")}
      </p>
    );
  }
  return (
    <div data-mode="invoice" className="flex flex-col gap-1 text-[12.5px]">
      <p className="text-muted-foreground">
        {t("mode.invoice", { max: formatCount(invoice.gauMax, locale) })}
      </p>
      <p data-fact="uninvoiced" className="text-muted-foreground">
        {t("mode.uninvoiced")}: {governed(invoice.uninvoicedGau)}.{" "}
        {t("mode.invoiced")}: {governed(invoice.invoicedThisPeriodGau)}.
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
  retention,
}: {
  bucket: Read<GauBucket>;
  retention: Read<EvidenceRetention>;
}) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const date = useDate();
  const title = t("meters.title");
  const count = (n: number) => formatCount(n, locale);
  const notRecorded = <NotRecordedValue>{t("notRecorded")}</NotRecordedValue>;
  const b = bucket.ok ? bucket.value : null;
  let governedValue: ReactNode;
  let governedNote: ReactNode = null;
  if (!bucket.ok) {
    governedValue = (
      <BillingReadFailure read={bucket} section={t("meters.governed")} />
    );
  } else {
    const v = bucket.value;
    governedValue = count(v.usedGau);
    governedNote = t("meters.governedNote", { included: count(v.includedGau) });
  }
  let retainedValue: ReactNode;
  let retainedNote: ReactNode = null;
  if (!retention.ok) {
    retainedValue = (
      <BillingReadFailure read={retention} section={t("meters.retained")} />
    );
  } else {
    const r = retention.value;
    retainedValue = notRecorded;
    retainedNote = t("meters.retainedNote", {
      months: count(r.includedMonths),
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
    <Section id="billing-meters" title={title} flush>
      <Table
        label={title}
        columns={[
          { label: t("meters.columns.meter") },
          { label: t("meters.columns.thisPeriod"), numeric: true },
          { label: t("meters.columns.note") },
        ]}
      >
        <Row
          name="governed"
          meter={t("meters.governed")}
          value={governedValue}
          note={governedNote}
        />
        <Row
          name="sealed"
          meter={t("meters.sealed")}
          value={notRecorded}
          note={t("meters.sealedNote")}
        />
        <Row
          name="retained"
          meter={t("meters.retained")}
          value={retainedValue}
          note={retainedNote}
        />
        <Row
          name="halted"
          meter={t("meters.halted")}
          value={notRecorded}
          note={t("meters.free")}
        />
        <Row
          name="in-app"
          meter={t("meters.inApp")}
          value={notRecorded}
          note={t("meters.free")}
        />
      </Table>
      <PanelNote>{t("meters.note")}</PanelNote>
      {b === null ? null : (
        <div className={`${panelBody} flex flex-col gap-2 pt-0`}>
          {b.remainingGau < 0 ? (
            <p data-overdrawn="" className="text-[12.5px] text-foreground">
              {t("meters.overdrawn", { count: count(-b.remainingGau) })}
            </p>
          ) : null}
          <Mode bucket={b} />
          {exhausted === null ? null : (
            <p
              data-exhausted=""
              className="text-[12.5px] font-medium text-foreground"
            >
              {t.rich("meters.exhaustedNoCard", {
                date: date(exhausted.period.end),
                link: (chunks) => (
                  <a href="#billing-buy" className={linkText}>
                    {chunks}
                  </a>
                ),
              })}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
