import { describe, expect, it } from "vitest";
import { billingSubscriptionRead } from "./billing.subscription.read";

describe("billing.subscription.read capability", () => {
  it("parses an empty input object", () => {
    const parsed = billingSubscriptionRead.input.parse({});
    expect(parsed).toEqual({});
  });

  it("rejects a non-object input", () => {
    expect(() => billingSubscriptionRead.input.parse("nope")).toThrow();
  });

  it("parses a valid output with a subscription", () => {
    const parsed = billingSubscriptionRead.output.parse({
      subscription: {
        publicId: "sub_abc",
        status: "active",
        planSlug: "pro",
        billingInterval: "month",
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date().toISOString(),
        cancelAtPeriodEnd: false,
        seatCount: 3,
      },
      creditBalanceCents: 1000,
      periodUsage: {
        inputTokens: 1200,
        outputTokens: 800,
        cachedTokens: 100,
        costMicros: 4500,
        executions: 7,
      },
    });
    expect(parsed.subscription?.planSlug).toBe("pro");
  });

  it("parses a valid output without a subscription", () => {
    const parsed = billingSubscriptionRead.output.parse({
      subscription: null,
      creditBalanceCents: 0,
      periodUsage: null,
    });
    expect(parsed.subscription).toBeNull();
  });

  it("rejects a bad billing interval", () => {
    expect(() =>
      billingSubscriptionRead.output.parse({
        subscription: {
          publicId: "sub_abc",
          status: "active",
          planSlug: "pro",
          billingInterval: "weekly",
          currentPeriodStart: new Date().toISOString(),
          currentPeriodEnd: new Date().toISOString(),
          cancelAtPeriodEnd: false,
          seatCount: 1,
        },
        creditBalanceCents: 0,
      }),
    ).toThrow();
  });
});
