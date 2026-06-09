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
import { billingProvider, setBillingProvider, resetBillingProvider } from "./client";
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
