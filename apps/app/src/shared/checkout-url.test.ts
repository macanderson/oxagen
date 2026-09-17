import { describe, expect, it } from "vitest";
import { parseCheckoutUrl } from "./checkout-url";

describe("parseCheckoutUrl", () => {
  it("accepts a Stripe Checkout page with its fragment, as written", () => {
    const raw =
      "https://checkout.stripe.com/c/pay/cs_test_a1B2c3#fidkdWxOYHwnPyd1blpxYHZxWjA0TDVvS0NcM2hRbVxRZ2F3YkhGQDJvRWJVM39JYGJUMHwxYm5uTWNsN0BBbDdMTjVWYEBJXzdJSEFfPENMUHVnXHV8M2t1T0x8YXFQRDJWVzJiYm1dSFE0NTVtbE9NbUk1XScpJ3VpbGtuQH11anZgYUxhJz8nPG5wYUxEPE1CYzRzPWNHPD1NMWMzJyknd2BjYHd3YHdKd2xibGsnPydtcXF1dj8qKmZtYGZuanBxK3Zxd2x1YCtmamgqJ3gl";
    expect(parseCheckoutUrl(raw)).toBe(raw);
  });

  it.each([
    ["plain http", "http://checkout.stripe.com/c/pay/cs_test_1"],
    ["another host", "https://invoice.stripe.com/c/pay/cs_test_1"],
    [
      "a host that only starts with it",
      "https://checkout.stripe.com.evil/c/pay/cs_test_1",
    ],
    ["a subdomain of it", "https://evil.checkout.stripe.com/c/pay/cs_test_1"],
    ["userinfo", "https://user:pw@checkout.stripe.com/c/pay/cs_test_1"],
    [
      "userinfo naming the host",
      "https://checkout.stripe.com@evil.example/c/pay/cs_test_1",
    ],
    ["an explicit port", "https://checkout.stripe.com:8443/c/pay/cs_test_1"],
    ["a form the parser rewrites", "https://CHECKOUT.stripe.com/c/pay/1"],
    ["dot segments", "https://checkout.stripe.com/c/../../evil"],
    ["a relative path", "/c/pay/cs_test_1"],
    ["javascript", "javascript:alert(1)"],
    ["no URL at all", "not a url"],
  ])("refuses %s (negative)", (_case, raw) => {
    expect(parseCheckoutUrl(raw)).toBeNull();
  });
});
