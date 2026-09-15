import { describe, expect, it } from "vitest";
import { parseCheckoutUrl } from "./checkout-url";

describe("parseCheckoutUrl", () => {
  it("accepts a Stripe-hosted Checkout session", () => {
    const raw =
      "https://checkout.stripe.com/c/pay/cs_test_a1b2#fidkdWxOYHwnPyd1";
    expect(parseCheckoutUrl(raw)).toBe(raw);
  });

  it.each([
    ["http", "http://checkout.stripe.com/c/pay/cs_test_a1"],
    ["another host", "https://evil.example/c/pay/cs_test_a1"],
    ["another Stripe host", "https://dashboard.stripe.com/c/pay/cs_test_a1"],
    ["a suffix host", "https://checkout.stripe.com.evil/c/pay/cs_test_a1"],
    ["a prefix host", "https://evilcheckout.stripe.com/c/pay/cs_test_a1"],
    ["userinfo", "https://user:pass@checkout.stripe.com/c/pay/cs_test_a1"],
    ["a host behind userinfo", "https://checkout.stripe.com@evil.example/"],
    ["a port", "https://checkout.stripe.com:8443/c/pay/cs_test_a1"],
    ["a relative path", "/billing?checkout=success"],
    ["an empty string", ""],
  ])("refuses %s (negative)", (_label, raw) => {
    expect(parseCheckoutUrl(raw)).toBeNull();
  });
});
