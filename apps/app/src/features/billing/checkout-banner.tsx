// The line the page shows after a Stripe Checkout round trip: Checkout sends
// the browser back to `?checkout=success`, `?checkout=credits`,
// `?checkout=plan` or `?checkout=cancel` (§3.8). Any other value shows
// nothing.
//
// The two purchases return to different values because they credit different
// meters (§3.9): `success` is a governed-action-unit purchase, added to the
// bucket, and `credits` is a usage credit top-up, added to the balance. One
// message for both told a credit buyer their governed action units had
// arrived. `plan` is a plan change from the Change plan dialog, which lands
// on the subscription. `cancel` is shared — nothing was charged.
import { useTranslations } from "next-intl";

const OUTCOMES = ["success", "cancel", "credits", "plan"] as const;

type CheckoutOutcome = (typeof OUTCOMES)[number];

export function checkoutOutcome(raw: string | null): CheckoutOutcome | null {
  return OUTCOMES.find((outcome) => outcome === raw) ?? null;
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
