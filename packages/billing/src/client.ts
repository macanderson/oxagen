import Stripe from "stripe";
import { requireEnv } from "@oxagen/config/env";

// One Stripe client per process. API version is pinned to match the
// webhook payload shape the verifier expects; bumping requires a payload
// re-test against billing.stripe_events fixtures.
let _stripe: Stripe | null = null;

export function stripeClient(): Stripe {
  if (_stripe) return _stripe;
  const env = requireEnv(["STRIPE_SECRET_KEY"] as const);
  _stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-02-24.acacia",
    typescript: true,
    appInfo: { name: "oxagen", version: "0.1.0" },
  });
  return _stripe;
}
