// The line the page shows after a Stripe Checkout round trip: Checkout sends
// the browser back to `?checkout=success` or `?checkout=cancel` (§3.8). Any
// other value shows nothing.
import { useTranslations } from "next-intl";

type CheckoutOutcome = "success" | "cancel";

export function checkoutOutcome(raw: string | null): CheckoutOutcome | null {
  return raw === "success" || raw === "cancel" ? raw : null;
}

export function CheckoutBanner({
  outcome,
}: {
  outcome: CheckoutOutcome | null;
}) {
  const t = useTranslations("billing.checkout");
  if (outcome === null) return null;
  return (
    <p
      role="status"
      data-checkout={outcome}
      className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground"
    >
      {t(outcome)}
    </p>
  );
}
