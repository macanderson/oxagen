import { describe, expect, it } from "vitest";
import { parseHostedInvoiceUrl } from "./invoice-url";

describe("parseHostedInvoiceUrl", () => {
  it("accepts a Stripe-hosted invoice page as written", () => {
    const raw = "https://invoice.stripe.com/i/acct_1Nx/test_YWNjdF8x?s=ap";
    expect(parseHostedInvoiceUrl(raw)).toBe(raw);
  });

  it.each([
    ["plain http", "http://invoice.stripe.com/i/acct_1Nx/test_1"],
    ["another host", "https://checkout.stripe.com/i/acct_1Nx/test_1"],
    ["a host that only starts with it", "https://invoice.stripe.com.evil/i/1"],
    ["a subdomain of it", "https://evil.invoice.stripe.com/i/1"],
    ["credentials", "https://user:pw@invoice.stripe.com/i/1"],
    ["an explicit port", "https://invoice.stripe.com:8443/i/1"],
    ["a form the parser rewrites", "https://INVOICE.stripe.com/i/1"],
    ["dot segments", "https://invoice.stripe.com/i/../../evil"],
    ["a relative path", "/i/acct_1Nx/test_1"],
    ["javascript", "javascript:alert(1)"],
    ["no URL at all", "not a url"],
  ])("refuses %s (negative)", (_case, raw) => {
    expect(parseHostedInvoiceUrl(raw)).toBeNull();
  });
});
