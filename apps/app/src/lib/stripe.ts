// Browser-safe: exposes only the publishable key. Server-side Stripe SDK
// usage stays in route handlers and server actions.
export const stripePublishableKey =
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? process.env.STRIPE_PUBLISHABLE_KEY ?? "";
