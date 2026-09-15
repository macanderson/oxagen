// A Stripe Checkout page (ARCHITECTURE.md §3.8): the one external target a
// redirect may send the browser to. An ExternalCheckoutUrl is an https URL on
// checkout.stripe.com with no credentials and no explicit port, written
// exactly as the URL parser writes it back; the purchase action refuses any
// other value the kernel returns.

declare const checkoutUrl: unique symbol;
export type ExternalCheckoutUrl = string & { readonly [checkoutUrl]: true };

const HOST = "checkout.stripe.com";

function isCheckoutUrl(raw: string, url: URL): raw is ExternalCheckoutUrl {
  return (
    url.protocol === "https:" &&
    url.hostname === HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.href === raw
  );
}

export function parseCheckoutUrl(raw: string): ExternalCheckoutUrl | null {
  if (!URL.canParse(raw)) return null;
  return isCheckoutUrl(raw, new URL(raw)) ? raw : null;
}
