import { ExternalLink, FileText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCents, formatDate } from "@/lib/utils";

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
    <Card>
      <CardHeader>
        <CardTitle>Invoices</CardTitle>
      </CardHeader>
      <CardContent>
        {invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {invoices.map((inv) => (
              <li key={inv.publicId} className="flex items-center justify-between py-3 text-sm">
                <div>
                  <div className="font-medium">{inv.number ?? inv.publicId}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatDate(inv.periodStart)} → {formatDate(inv.periodEnd)}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={inv.status === "paid" ? "success" : "warn"}>{inv.status}</Badge>
                  <span className="font-medium">{formatCents(inv.amountDueCents, inv.currency.toUpperCase())}</span>
                  {inv.hostedInvoiceUrl ? (
                    <Button asChild size="sm" variant="ghost">
                      <a href={inv.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </Button>
                  ) : null}
                  {inv.invoicePdfUrl ? (
                    <Button asChild size="sm" variant="ghost">
                      <a href={inv.invoicePdfUrl} target="_blank" rel="noreferrer">
                        <FileText className="h-3.5 w-3.5" />
                      </a>
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
