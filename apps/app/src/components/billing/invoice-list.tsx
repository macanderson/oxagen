import { ExternalLink, FileText } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCents, formatDate } from "@/lib/utils";
import { safeHref } from "@/lib/safe-url";

export interface Invoice {
  publicId: string;
  number: string | null;
  status: string;
  amountDueCents: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  paidAt: string | null;
}

export function InvoiceList({ invoices }: { invoices: Invoice[] }) {
  return (
    <Panel title="Invoices">
      {invoices.length === 0 ? (
        <EmptyState
          icon={<FileText />}
          title="No invoices yet"
          description="Invoices appear here after your first billing cycle."
          variant="muted"
        />
      ) : (
        <ul className="divide-y divide-border/60">
          {invoices.map((inv) => {
            // Invoice URLs mirror Stripe-supplied values; validate the scheme
            // before rendering so a non-https value can never become a link.
            const hostedUrl = safeHref(inv.hostedInvoiceUrl);
            const pdfUrl = safeHref(inv.invoicePdfUrl);
            return (
              <li
                key={inv.publicId}
                className="flex items-center justify-between py-3 text-sm"
              >
                <div>
                  <div className="font-medium">
                    {inv.number ?? inv.publicId}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatDate(inv.periodStart)} → {formatDate(inv.periodEnd)}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge
                    variant={inv.status === "paid" ? "success" : "warning"}
                  >
                    {inv.status}
                  </Badge>
                  <span className="font-medium">
                    {formatCents(
                      inv.amountDueCents,
                      inv.currency.toUpperCase(),
                    )}
                  </span>
                  {hostedUrl ? (
                    <Button
                      render={
                        <a href={hostedUrl} target="_blank" rel="noreferrer" />
                      }
                      size="sm"
                      variant="ghost"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                  {pdfUrl ? (
                    <Button
                      render={
                        <a href={pdfUrl} target="_blank" rel="noreferrer" />
                      }
                      size="sm"
                      variant="ghost"
                    >
                      <FileText className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
