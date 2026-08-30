import { describe, it, expect } from "vitest";
import { billingCreditsPurchase } from "./billing.credits.purchase";
import { getCapability } from "../registry";

describe("billing.credits.purchase capability", () => {
  it("is registered", () => {
    expect(getCapability("purchase_credits")).toBeDefined();
  });

  it("parses a valid input", () => {
    expect(() =>
      billingCreditsPurchase.input.parse({ amountUsd: 50 }),
    ).not.toThrow();
  });

  it("parses input with optional successUrl and cancelUrl", () => {
    expect(() =>
      billingCreditsPurchase.input.parse({
        amountUsd: 50,
        successUrl: "https://app.example.com/billing?status=success",
        cancelUrl: "https://app.example.com/billing?status=canceled",
      }),
    ).not.toThrow();
  });

  it("accepts input without successUrl and cancelUrl (they are optional)", () => {
    const result = billingCreditsPurchase.input.parse({ amountUsd: 25 });
    expect(result.successUrl).toBeUndefined();
    expect(result.cancelUrl).toBeUndefined();
  });

  it("rejects invalid successUrl", () => {
    expect(() =>
      billingCreditsPurchase.input.parse({
        amountUsd: 50,
        successUrl: "not-a-url",
      }),
    ).toThrow();
  });

  it("rejects invalid cancelUrl", () => {
    expect(() =>
      billingCreditsPurchase.input.parse({
        amountUsd: 50,
        cancelUrl: "not-a-url",
      }),
    ).toThrow();
  });

  it("rejects amountUsd below minimum ($5)", () => {
    expect(() =>
      billingCreditsPurchase.input.parse({ amountUsd: 4 }),
    ).toThrow();
  });

  it("rejects zero amountUsd", () => {
    expect(() =>
      billingCreditsPurchase.input.parse({ amountUsd: 0 }),
    ).toThrow();
  });

  it("rejects negative amountUsd", () => {
    expect(() =>
      billingCreditsPurchase.input.parse({ amountUsd: -10 }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    expect(() =>
      billingCreditsPurchase.output.parse({
        url: "https://checkout.stripe.com/c/pay/cs_test_xxx",
        grantCents: 25000,
        priceCents: 21250,
        percent: 15,
      }),
    ).not.toThrow();
  });

  it("rejects output with invalid URL", () => {
    expect(() =>
      billingCreditsPurchase.output.parse({
        url: "not-a-url",
        grantCents: 25000,
        priceCents: 21250,
        percent: 15,
      }),
    ).toThrow();
  });

  it("rejects output with non-positive grantCents", () => {
    expect(() =>
      billingCreditsPurchase.output.parse({
        url: "https://checkout.stripe.com/c/pay/cs_test_xxx",
        grantCents: 0,
        priceCents: 21250,
        percent: 15,
      }),
    ).toThrow();
  });

  it("capability has correct defaults", () => {
    expect(billingCreditsPurchase.defaultEffect).toBe("deny");
    expect(billingCreditsPurchase.defaultRoles?.org?.Owner).toBe("allow");
    expect(billingCreditsPurchase.defaultRoles?.org?.Billing).toBe("allow");
  });
});
