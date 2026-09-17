// A Stripe-hosted invoice page (ARCHITECTURE.md §1.4 Invoices, §3.8): the
// external target an invoice row links to. A HostedInvoiceUrl is an https URL
// on invoice.stripe.com with no credentials and no explicit port, written
// exactly as the URL parser writes it back; any other value is not linked.

declare const hostedInvoiceUrl: unique symbol;
export type HostedInvoiceUrl = string & { readonly [hostedInvoiceUrl]: true };

const HOST = "invoice.stripe.com";

function isHostedInvoiceUrl(raw: string, url: URL): raw is HostedInvoiceUrl {
  return (
    url.protocol === "https:" &&
    url.hostname === HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.href === raw
  );
}

export function parseHostedInvoiceUrl(raw: string): HostedInvoiceUrl | null {
  if (!URL.canParse(raw)) return null;
  return isHostedInvoiceUrl(raw, new URL(raw)) ? raw : null;
}
