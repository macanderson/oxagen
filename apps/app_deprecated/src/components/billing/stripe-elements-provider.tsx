"use client";

import * as React from "react";
import { Elements } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";

// Module-scope memo: loadStripe is expensive and must not be called per render.
// Keyed by publishable key so different keys in tests or env-var changes get
// their own promise without leaking across environments.
const stripePromiseCache = new Map<string, Promise<Stripe | null>>();

function getStripePromise(publishableKey: string): Promise<Stripe | null> {
  const cached = stripePromiseCache.get(publishableKey);
  if (cached) return cached;
  const promise = loadStripe(publishableKey);
  stripePromiseCache.set(publishableKey, promise);
  return promise;
}

export interface StripeElementsProviderProps {
  publishableKey: string | undefined;
  clientSecret: string;
  children: React.ReactNode;
}

/**
 * StripeElementsProvider — thin, memoised wrapper around Stripe Elements.
 *
 * `loadStripe` is memoised at module scope (never called per render).
 * If `publishableKey` is falsy we render a graceful degradation notice
 * instead of crashing.
 */
export function StripeElementsProvider({
  publishableKey,
  clientSecret,
  children,
}: StripeElementsProviderProps) {
  if (!publishableKey) {
    return (
      <Alert variant="warning">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Card management is unavailable — STRIPE publishable key not
          configured.
        </AlertDescription>
      </Alert>
    );
  }

  const stripePromise = getStripePromise(publishableKey);

  return (
    <Elements
      stripe={stripePromise}
      options={{ clientSecret, appearance: { theme: "stripe" } }}
    >
      {children}
    </Elements>
  );
}
