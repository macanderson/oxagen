import { describe, it, expect } from "vitest";
import { billingSubscriptionUpgradeStart } from "./billing.subscription_upgrade.start";
import { getCapability } from "../registry";

describe("billing.subscription.upgrade.start capability", () => {
  it("is registered", () => {
    expect(getCapability("start_subscription_upgrade")).toBeDefined();
  });

  it("parses a valid input", () => {
    expect(() =>
      billingSubscriptionUpgradeStart.input.parse({
        planSlug: "pro",
        interval: "month",
        successUrl: "https://app.example.com/billing/return",
        cancelUrl: "https://app.example.com/billing/plans",
      }),
    ).not.toThrow();
  });

  it("rejects invalid interval", () => {
    expect(() =>
      billingSubscriptionUpgradeStart.input.parse({
        planSlug: "pro",
        interval: "weekly",
        successUrl: "https://app.example.com/x",
        cancelUrl: "https://app.example.com/y",
      }),
    ).toThrow();
  });

  it("requires URL-shaped success/cancel", () => {
    expect(() =>
      billingSubscriptionUpgradeStart.input.parse({
        planSlug: "pro",
        interval: "month",
        successUrl: "not-a-url",
        cancelUrl: "https://app.example.com/y",
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    expect(() =>
      billingSubscriptionUpgradeStart.output.parse({
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_xxx",
        planSlug: "pro",
        interval: "month",
      }),
    ).not.toThrow();
  });

  it("rejects an invalid output", () => {
    expect(() =>
      billingSubscriptionUpgradeStart.output.parse({
        checkoutUrl: "not-a-url",
        planSlug: "pro",
        interval: "month",
      }),
    ).toThrow();
  });
});
