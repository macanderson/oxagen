// Invoices (§1.4, §3.9 contracts): one cursor page, newest first, each with its
// number, what it charged for, its status, period, the amounts due and paid,
// and the Stripe-hosted page that collects it. One of the two places money
// renders (INV-25).
import { useTranslations } from "next-intl";
import type { InvoicePage, InvoiceRow } from "@/data/contracts/billing";
import type { Read } from "@/data/read";
import { parseHostedInvoiceUrl } from "@/shared/invoice-url";
import { routes } from "@/shared/safe-path";
import { linkText } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { HostedInvoiceLink, SafeLink } from "@/ui/navigation";
import { cell, numericCell, Table } from "@/ui/table";
import { ReadFailure } from "./read-failure";
import { Section, useDate } from "./section";

function InvoiceLine({ row }: { row: InvoiceRow }) {
  const t = useTranslations("billing");
  const date = useDate();
  const url =
    row.hostedInvoiceUrl === null
      ? null
      : parseHostedInvoiceUrl(row.hostedInvoiceUrl);
  return (
    <tr data-kind={row.kind} data-status={row.status}>
      <td className={cell}>{row.number ?? t("invoices.unnumbered")}</td>
      <td className={cell}>{t(`invoices.kinds.${row.kind}`)}</td>
      <td className={cell}>{t(`invoices.statuses.${row.status}`)}</td>
      <td className={cell}>
        {t("range", {
          start: date(row.periodStart),
          end: date(row.periodEnd),
        })}
      </td>
      <td className={numericCell}>
        <Money value={row.amountDue} />
      </td>
      <td className={numericCell}>
        <Money value={row.amountPaid} />
      </td>
      <td className={cell}>
        {url === null ? (
          t("invoices.unpublished")
        ) : (
          <HostedInvoiceLink to={url} className={linkText}>
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
        <ReadFailure read={invoices} section={title} />
      </Section>
    );
  }
  const { items, nextCursor } = invoices.value;
  return (
    <Section id="billing-invoices" title={title}>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table
          label={title}
          columns={[
            { label: t("columns.number") },
            { label: t("columns.kind") },
            { label: t("columns.status") },
            { label: t("columns.period") },
            { label: t("columns.amountDue"), numeric: true },
            { label: t("columns.amountPaid"), numeric: true },
            { label: t("columns.invoice") },
          ]}
        >
          {items.map((row) => (
            <InvoiceLine key={row.id} row={row} />
          ))}
        </Table>
      )}
      {cursor === null && nextCursor === null ? null : (
        <nav aria-label={t("pager")} className="flex gap-4 text-sm">
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
