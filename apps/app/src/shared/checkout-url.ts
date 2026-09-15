// The one external navigation target (ARCHITECTURE.md §3.8): a Stripe-hosted
// Checkout page. An ExternalCheckoutUrl is https on exactly checkout.stripe.com
// (no port, no credentials), so a URL a kernel result carries cannot send the
// browser anywhere else.

declare const checkoutUrl: unique symbol;
export type ExternalCheckoutUrl = string & { readonly [checkoutUrl]: true };

const CHECKOUT_HOST = "checkout.stripe.com";

function isCheckoutUrl(raw: string, url: URL): raw is ExternalCheckoutUrl {
  return (
    url.protocol === "https:" &&
    url.host === CHECKOUT_HOST &&
    url.username === "" &&
    url.password === ""
  );
}

export function parseCheckoutUrl(raw: string): ExternalCheckoutUrl | null {
  if (!URL.canParse(raw)) return null;
  return isCheckoutUrl(raw, new URL(raw)) ? raw : null;
}
