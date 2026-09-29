// Invoices (§1.4, §3.9 contracts; pages/billing.md): newest first, each with
// its number, its period (the month, as the design prints it), the governed
// actions it charged for, the amount, its status as a dot and a word, the day
// it was paid, and the Stripe-hosted page that collects it. list_invoices
// carries neither a governed-action count nor a paid date per invoice yet
// (#3840), so those two columns say "not recorded" rather than a figure. The
// table carries the design's search and filters (@/ui/list-table) over the
// page the read returned. The pager beneath it pages by address (#4693): Rows
// per page on the left sets how many invoices a read returns, and Newest and
// Older on the right walk the pages. One of the files money renders in
// (INV-25).
import { useTranslations } from "next-intl";
import type { InvoicePage, InvoiceRow } from "@/data/contracts/billing";
import { parseHostedInvoiceUrl } from "@/shared/invoice-url";
import { routes } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import { linkText, mono } from "@/ui/control-styles";
import { type ListRow, ListTable } from "@/ui/list-table";
import { Money } from "@/ui/money";
import { HostedInvoiceLink } from "@/ui/navigation";
import { cell } from "@/ui/table";
import { NotRecordedValue, Section, usePeriod } from "./section";

/** The sizes Rows offers under the invoices (#4693). */
const INVOICE_ROWS = [10, 25, 50, 100] as const;
/** The invoices a page holds when the address names no size, the same 50 `list_invoices` reads by default. */
const INVOICE_PAGE = 50;

/**
 * The invoices a page holds, from `?rows=`. A size Rows does not offer reads
 * as `INVOICE_PAGE`, so a hand-typed URL cannot ask for a size the list never
 * draws.
 */
export function invoiceRowsOf(raw: string | null): number {
  const rows = Number(raw);
  return INVOICE_ROWS.find((size) => size === rows) ?? INVOICE_PAGE;
}

/** `?rows=` for a size, left off at the default so the plain address stays the plain page. */
function rowsParam(rows: number): { rows?: string } {
  return rows === INVOICE_PAGE ? {} : { rows: String(rows) };
}

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
            data-touch-target=""
            className={`${linkText} max-md:inline-flex max-md:items-center`}
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
  rows,
  org,
}: {
  invoices: InvoicePage;
  /** The page on screen; null is the newest. */
  cursor: string | null;
  /** The invoices a page holds, one of `INVOICE_ROWS` (#4693). */
  rows: number;
  org: string;
}) {
  const t = useTranslations("billing.invoices");
  const list = useTranslations("ui.list");
  const toRow = useInvoiceRow();
  const title = t("title");
  const { items, nextCursor } = invoices;
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
        // The cursor only walks toward older invoices, so the step back is
        // the newest page. Both steps keep the size, and a new size starts
        // over at the newest page (#4693).
        pager={{
          label: t("pager"),
          rowsLabel: list("rows"),
          previousLabel: t("newest"),
          nextLabel: t("older"),
          perPage: rows,
          sizes: INVOICE_ROWS.map((size) => ({
            size,
            first: routes.billing(org, rowsParam(size)),
          })),
          previous:
            cursor === null ? null : routes.billing(org, rowsParam(rows)),
          next:
            nextCursor === null
              ? null
              : routes.billing(org, {
                  ...rowsParam(rows),
                  cursor: nextCursor,
                }),
        }}
      />
    </Section>
  );
}
