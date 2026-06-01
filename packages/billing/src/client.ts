import type { BillingProvider } from "./provider.js";
import { StripeProvider } from "./stripe-provider.js";

/**
 * client.ts — Billing provider singleton.
 *
 * All billing business logic obtains the active BillingProvider through
 * `billingProvider()`. The default implementation is StripeProvider; it can
 * be replaced via `setBillingProvider` in tests or to swap vendors.
 *
 * The Stripe SDK itself is only referenced in stripe-provider.ts — nothing
 * else in the billing package imports `stripe` directly.
 */

let _provider: BillingProvider | null = null;

export function billingProvider(): BillingProvider {
  if (_provider) return _provider;
  _provider = new StripeProvider();
  return _provider;
}

/**
 * Override the billing provider. Intended for tests and future vendor-swap;
 * production code always calls `billingProvider()`.
 */
export function setBillingProvider(provider: BillingProvider): void {
  _provider = provider;
}

/**
 * Reset to the default StripeProvider. For use in test teardowns.
 */
export function resetBillingProvider(): void {
  _provider = null;
}
