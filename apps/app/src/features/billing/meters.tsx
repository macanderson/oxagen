// Meters (pages/billing.md): the one priced meter and the meters reported
// beside it, then the design's note, and nothing else. Governed actions lead:
// the count used this period against the bucket, the billable unit. Sealed
// runs with a model call, runs Oxagen halted before any model call and runs of
// the in-app agent have no read in this release (the cost.run_totals rollup,
// spec §12.6; #3836), so each prints "not recorded" rather than a zero.
// Retained evidence has no volume on record either (get_evidence_retention
// carries only the volume beyond the included window, unmeasured; #3838), so
// it too says "not recorded", with the included window beside it. The table
// carries the design's list controls (@/ui/list-table). Counts only; no money
// renders here (INV-25).
import { useLocale, useTranslations } from "next-intl";
import type { EvidenceRetention, GauBucket } from "@/data/contracts/billing";
import type { Read } from "@/data/read";
import { type ListRow, ListTable } from "@/ui/list-table";
import { formatCount } from "@/ui/money-format";
import { cell } from "@/ui/table";
import { BillingReadFailure } from "./read-failure";
import { NotRecordedValue, PanelNote, Section } from "./section";

export function Meters({
  bucket,
  retention,
}: {
  bucket: Read<GauBucket>;
  retention: Read<EvidenceRetention>;
}) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const title = t("meters.title");
  const count = (n: number) => formatCount(n, locale);
  const notRecorded = <NotRecordedValue>{t("notRecorded")}</NotRecordedValue>;
  let governedValue: ListRow["cells"][number];
  let governedNote: ListRow["cells"][number] = null;
  if (!bucket.ok) {
    governedValue = (
      <BillingReadFailure read={bucket} section={t("meters.governed")} />
    );
  } else {
    const v = bucket.value;
    governedValue = count(v.usedGau);
    governedNote = t("meters.governedNote", { included: count(v.includedGau) });
  }
  let retainedValue: ListRow["cells"][number];
  let retainedNote: ListRow["cells"][number] = null;
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
  const row = (
    name: string,
    meter: string,
    value: ListRow["cells"][number],
    note: ListRow["cells"][number],
  ): ListRow => ({
    key: name,
    cells: [meter, value, note],
    data: { "data-meter": name },
  });
  return (
    <Section id="billing-meters" title={title} flush>
      <ListTable
        label={title}
        columns={[
          { label: t("meters.columns.meter") },
          { label: t("meters.columns.thisPeriod"), numeric: true },
          {
            label: t("meters.columns.note"),
            className: `${cell} text-[11.5px] text-muted-foreground`,
          },
        ]}
        rows={[
          row("governed", t("meters.governed"), governedValue, governedNote),
          row(
            "sealed",
            t("meters.sealed"),
            notRecorded,
            t("meters.sealedNote"),
          ),
          row("retained", t("meters.retained"), retainedValue, retainedNote),
          row("halted", t("meters.halted"), notRecorded, t("meters.free")),
          row("in-app", t("meters.inApp"), notRecorded, t("meters.free")),
        ]}
      />
      <PanelNote>{t("meters.note")}</PanelNote>
    </Section>
  );
}
