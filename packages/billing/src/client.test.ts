/**
 * Unit tests for client.ts — BillingProvider singleton management.
 *
 * Covers:
 *  - billingProvider() creates a StripeProvider on first call
 *  - billingProvider() returns the same instance on subsequent calls
 *  - setBillingProvider() overrides the active provider
 *  - resetBillingProvider() clears back to null so billingProvider() re-creates
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getBreaker,
  __resetBreakerRegistry,
  CircuitOpenError,
} from "@oxagen/telemetry";
import {
  billingProvider,
  setBillingProvider,
  resetBillingProvider,
} from "./client";
import type { BillingProvider } from "./provider";

function makeStubProvider(): BillingProvider {
  return {} as BillingProvider;
}

describe("billingProvider singleton", () => {
  beforeEach(() => {
    resetBillingProvider();
  });

  it("returns a non-null provider on first call", () => {
    const p = billingProvider();
    expect(p).toBeTruthy();
  });

  it("returns the same instance on repeated calls (singleton)", () => {
    const a = billingProvider();
    const b = billingProvider();
    expect(a).toBe(b);
  });

  it("setBillingProvider overrides the returned provider", () => {
    const stub = makeStubProvider();
    setBillingProvider(stub);
    expect(billingProvider()).toBe(stub);
  });

  it("resetBillingProvider clears the provider so billingProvider() re-creates", () => {
    const original = billingProvider();
    resetBillingProvider();
    const reCreated = billingProvider();
    // Different instances — the singleton was cleared.
    expect(reCreated).not.toBe(original);
  });

  it("setBillingProvider followed by reset then billingProvider creates a fresh instance", () => {
    const stub = makeStubProvider();
    setBillingProvider(stub);
    resetBillingProvider();
    const fresh = billingProvider();
    expect(fresh).not.toBe(stub);
  });
});

describe("billingProvider circuit breaker", () => {
  beforeEach(() => {
    resetBillingProvider();
    __resetBreakerRegistry();
  });

  it("fails fast with CircuitOpenError when the stripe breaker is open (no Stripe call)", async () => {
    // Pre-register the shared "stripe" breaker (registry keeps the first
    // instance, so billingProvider() reuses this one) with a no-op sink and a
    // 1-failure trip, then open it. The provider method must now fail fast
    // WITHOUT invoking the underlying StripeProvider (no env/network needed).
    const b = getBreaker("stripe", {
      failureThreshold: 1,
      onTransition: () => undefined,
    });
    await expect(
      b.exec(() => Promise.reject(new Error("stripe down"))),
    ).rejects.toThrow();
    expect(b.getState()).toBe("open");

    const provider = billingProvider();
    await expect(provider.getSubscription("sub_1")).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
  });

  it("does not gate parseWebhookEvent on the breaker (sync signature verification)", async () => {
    const b = getBreaker("stripe", {
      failureThreshold: 1,
      onTransition: () => undefined,
    });
    await expect(
      b.exec(() => Promise.reject(new Error("stripe down"))),
    ).rejects.toThrow();
    expect(b.getState()).toBe("open");

    const provider = billingProvider();
    // Reaches the real StripeProvider (throws a signature/env error) rather than
    // failing fast — proving webhook verification is not gated by the breaker.
    let thrown: unknown;
    try {
      provider.parseWebhookEvent("{}", "bad-sig");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown).not.toBeInstanceOf(CircuitOpenError);
  });
});
