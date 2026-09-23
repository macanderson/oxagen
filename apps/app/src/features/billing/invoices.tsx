// Invoices (§1.4, §3.9 contracts; pages/billing.md): one cursor page, newest
// first, each with its number, period, the governed actions it charged for,
// the amount, its status as a dot and a word, what was paid, and the
// Stripe-hosted page that collects it. list_invoices carries no governed-action
// count per invoice yet, so that column says "not recorded" rather than a
// figure. One of the files money renders in (INV-25).
import { useTranslations } from "next-intl";
import type { InvoicePage, InvoiceRow } from "@/data/contracts/billing";
import type { Read } from "@/data/read";
import { parseHostedInvoiceUrl } from "@/shared/invoice-url";
import { routes } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import { linkText, mono, panelBody } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { HostedInvoiceLink, SafeLink } from "@/ui/navigation";
import { cell, numericCell, Table } from "@/ui/table";
import { BillingReadFailure } from "./read-failure";
import { NotRecordedValue, Section, useDate } from "./section";

const STATUS_TONE: Record<InvoiceRow["status"], BadgeTone> = {
  paid: "allowed",
  open: "approval",
  uncollectible: "failed",
  void: "quiet",
};

function InvoiceLine({ row }: { row: InvoiceRow }) {
  const t = useTranslations("billing");
  const date = useDate();
  const url =
    row.hostedInvoiceUrl === null
      ? null
      : parseHostedInvoiceUrl(row.hostedInvoiceUrl);
  const number = row.number ?? t("invoices.unnumbered");
  return (
    <tr data-kind={row.kind} data-status={row.status}>
      <td className={`${cell} ${mono}`}>{number}</td>
      <td className={cell}>
        {t("range", {
          start: date(row.periodStart),
          end: date(row.periodEnd),
        })}
      </td>
      <td className={numericCell}>
        <NotRecordedValue>{t("notRecorded")}</NotRecordedValue>
      </td>
      <td className={numericCell}>
        <Money value={row.amountDue} />
      </td>
      <td className={cell}>
        <Badge tone={STATUS_TONE[row.status]}>
          {t(`invoices.statuses.${row.status}`)}
        </Badge>
      </td>
      <td className={numericCell}>
        <Money value={row.amountPaid} />
      </td>
      <td className={cell}>
        {url === null ? (
          <NotRecordedValue>{t("invoices.unpublished")}</NotRecordedValue>
        ) : (
          <HostedInvoiceLink
            to={url}
            className={linkText}
            aria-label={t("invoices.viewLabel", { number })}
          >
            {t("invoices.view")}
          </HostedInvoiceLink>
        )}
      </td>
    </tr>
  );
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
      <Table
        label={title}
        columns={[
          { label: t("columns.invoice") },
          { label: t("columns.period") },
          { label: t("columns.governed"), numeric: true },
          { label: t("columns.amount"), numeric: true },
          { label: t("columns.status") },
          { label: t("columns.paid"), numeric: true },
          { label: t("columns.link"), hidden: true },
        ]}
      >
        {items.map((row) => (
          <InvoiceLine key={row.id} row={row} />
        ))}
      </Table>
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
