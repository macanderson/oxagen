// The pay journey (ARCHITECTURE.md §6.3): the Billing page opens a real Stripe
// Checkout session for a governed-action-unit purchase.
//
// This is the one e2e that spends a provider's time, and it proves the thing a
// unit test cannot: that the price the app quotes is a price Stripe will open a
// session for. A catalogue whose price was archived out from under billing.plans
// fails here and nowhere else (docs/ops/stripe-product-sync-sop.md).
//
// It stops at the Checkout page rather than paying: the assertion is that Stripe
// accepted the session and is showing it. Completing a payment would need a card
// and would leave a charge behind on every CI run.
//
// STRIPE_E2E is "0" on a fork pull request, which has no test key (WL-48). The
// spec skips rather than fails there, because a missing secret is not a defect
// in the code under test.
import { expect, test } from "@playwright/test";
import billingCatalog from "../messages/billing.json" with { type: "json" };
import { SEED } from "./support";

const copy = billingCatalog.billing.purchase;

test("the Billing page opens a Stripe Checkout session for a GAU purchase", async ({
  page,
}) => {
  test.skip(
    process.env.STRIPE_E2E !== "1",
    "no Stripe test key in this job (fork pull request)",
  );

  await page.goto(`/${SEED.orgSlug}/billing`);
  await expect(page).toHaveTitle(/Billing · Oxagen/);

  const form = page.getByRole("form", { name: copy.title });
  const quantity = form.locator("#purchase-quantity");
  await expect(quantity).toBeVisible();

  // One whole block, whatever the seeded contract rate's block size is: the
  // form refuses a partial block, and the step attribute is that block size.
  const step = await quantity.getAttribute("step");
  await quantity.fill(step ?? "1");

  await Promise.all([
    page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 }),
    form.getByRole("button", { name: copy.submit }).click(),
  ]);

  // Stripe is showing the session rather than an error page.
  expect(new URL(page.url()).hostname).toBe("checkout.stripe.com");
  await expect(page.locator("body")).not.toContainText("Something went wrong");
});
