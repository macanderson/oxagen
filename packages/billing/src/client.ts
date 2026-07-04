import { stripeBreaker } from "@oxagen/telemetry";
import type { BillingProvider } from "./provider";
import { StripeProvider } from "./stripe-provider";

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

/**
 * Provider methods that must NOT be gated by the circuit breaker. Signature
 * verification is local crypto, not a network dependency — gating it would both
 * (a) miscount a forged-signature error as a Stripe outage and (b) change its
 * synchronous return contract. Everything else is a Stripe network call.
 */
const UNGUARDED_PROVIDER_METHODS = new Set<string>(["parseWebhookEvent"]);

/**
 * Wrap a BillingProvider so each async (network) method runs inside the shared
 * "stripe" circuit breaker: a degraded Stripe API fails fast (CircuitOpenError)
 * instead of every billing request piling onto a down dependency. We wrap at the
 * PROVIDER-METHOD boundary (not the raw Stripe client) so the breaker observes a
 * whole logical operation and never transforms Stripe's rich return values (e.g.
 * `ApiListPromise` paging) — the method resolves to a plain domain object.
 */
function guardProviderWithBreaker(provider: BillingProvider): BillingProvider {
  const breaker = stripeBreaker();
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (UNGUARDED_PROVIDER_METHODS.has(prop as string)) {
        return (value as (...a: unknown[]) => unknown).bind(target);
      }
      return (...args: unknown[]) =>
        breaker.exec(
          () => Reflect.apply(value as (...a: unknown[]) => unknown, target, args) as Promise<unknown>,
        );
    },
  });
}

export function billingProvider(): BillingProvider {
  if (_provider) return _provider;
  _provider = guardProviderWithBreaker(new StripeProvider());
  return _provider;
}

/**
 * Override the billing provider. Intended for tests and future vendor-swap;
 * production code always calls `billingProvider()`. Injected providers are used
 * as-is (not breaker-wrapped) so tests observe their fake directly.
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
