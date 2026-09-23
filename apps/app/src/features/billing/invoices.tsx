// Invoices (§1.4, §3.9 contracts; pages/billing.md): newest first, each with
// its number, its period (the month, as the design prints it), the governed
// actions it charged for, the amount, its status as a dot and a word, the day
// it was paid, and the Stripe-hosted page that collects it. list_invoices
// carries neither a governed-action count nor a paid date per invoice yet
// (#3840), so those two columns say "not recorded" rather than a figure. The
// table carries the design's list controls (@/ui/list-table) over the page the
// read returned, 50 invoices. Only an organization with more than that sees
// the older-and-newest links beneath it, the one way to reach the rest until
// the read returns them all. One of the files money renders in (INV-25).
import { useTranslations } from "next-intl";
import type { InvoicePage, InvoiceRow } from "@/data/contracts/billing";
import type { Read } from "@/data/read";
import { parseHostedInvoiceUrl } from "@/shared/invoice-url";
import { routes } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import { linkText, mono, panelBody } from "@/ui/control-styles";
import { type ListRow, ListTable } from "@/ui/list-table";
import { Money } from "@/ui/money";
import { HostedInvoiceLink, SafeLink } from "@/ui/navigation";
import { cell } from "@/ui/table";
import { BillingReadFailure } from "./read-failure";
import { NotRecordedValue, Section, usePeriod } from "./section";

const STATUS_TONE: Record<InvoiceRow["status"], BadgeTone> = {
  paid: "allowed",
  open: "approval",
  uncollectible: "failed",
  void: "quiet",
};

function useInvoiceRow(): (row: InvoiceRow) => ListRow {
  const t = useTranslations("billing");
  const period = usePeriod();
  const notRecorded = <NotRecordedValue>{t("notRecorded")}</NotRecordedValue>;
  return (row) => {
    const url =
      row.hostedInvoiceUrl === null
        ? null
        : parseHostedInvoiceUrl(row.hostedInvoiceUrl);
    const number = row.number ?? t("invoices.unnumbered");
    return {
      key: row.id,
      data: { "data-kind": row.kind, "data-status": row.status },
      cells: [
        number,
        period(row.periodStart, row.periodEnd),
        notRecorded,
        <Money key="amount" value={row.amountDue} />,
        <Badge key="status" tone={STATUS_TONE[row.status]}>
          {t(`invoices.statuses.${row.status}`)}
        </Badge>,
        notRecorded,
        url === null ? (
          <NotRecordedValue key="link">
            {t("invoices.unpublished")}
          </NotRecordedValue>
        ) : (
          <HostedInvoiceLink
            key="link"
            to={url}
            className={linkText}
            aria-label={t("invoices.viewLabel", { number })}
          >
            {t("invoices.view")}
          </HostedInvoiceLink>
        ),
      ],
    };
  };
}

export function Invoices({
  invoices,
  cursor,
  org,
}: {
  invoices: Read<InvoicePage>;
  /** The page on screen; null is the newest. */
  cursor: string | null;
  org: string;
}) {
  const t = useTranslations("billing.invoices");
  const toRow = useInvoiceRow();
  const title = t("title");
  if (!invoices.ok) {
    return (
      <Section id="billing-invoices" title={title}>
        <BillingReadFailure read={invoices} section={title} />
      </Section>
    );
  }
  const { items, nextCursor } = invoices.value;
  if (items.length === 0 && cursor === null) {
    return (
      <Section id="billing-invoices" title={title}>
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </Section>
    );
  }
  return (
    <Section id="billing-invoices" title={title} flush>
      <ListTable
        label={title}
        columns={[
          { label: t("columns.invoice"), className: `${cell} ${mono}` },
          { label: t("columns.period") },
          { label: t("columns.governed"), numeric: true },
          { label: t("columns.amount"), numeric: true },
          { label: t("columns.status") },
          { label: t("columns.paid") },
          { label: t("columns.link"), hidden: true },
        ]}
        rows={items.map(toRow)}
      />
      {cursor === null && nextCursor === null ? null : (
        <nav
          aria-label={t("pager")}
          className={`${panelBody} flex gap-4 text-sm`}
        >
          {cursor === null ? null : (
            <SafeLink to={routes.billing(org)} className={linkText}>
              {t("newest")}
            </SafeLink>
          )}
          {nextCursor === null ? null : (
            <SafeLink
              to={routes.billing(org, { cursor: nextCursor })}
              className={linkText}
            >
              {t("older")}
            </SafeLink>
          )}
        </nav>
      )}
    </Section>
  );
}
