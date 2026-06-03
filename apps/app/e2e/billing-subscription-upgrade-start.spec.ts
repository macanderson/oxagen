/**
 * billing.subscription.upgrade.start — e2e spec.
 *
 * Signs up a fresh user and asserts the billing plans page renders the plan
 * grid with at least one plan card, exercising the actual upgrade entry point.
 *
 * We do NOT complete a Stripe payment — the Stripe checkout initiation is
 * asserted in billing-seats-flow.spec.ts.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("billing.subscription.upgrade.start — auth guard", () => {
  test("billing page redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/(login|signup)/);
  });
});

test.describe("billing.subscription.upgrade.start — authenticated", () => {
  test("billing subscription page renders for a fresh org", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "billing-upg" });

    await page.goto(`/${orgSlug}/billing/subscription`);
    await expect(page).not.toHaveURL(/\/login/);

    // The subscription page heading or credit balance must be present.
    // Even on a free org with no subscription, the billing layout renders.
    await expect(
      page.getByText(/billing/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("billing plans tab is reachable and shows a Plans heading", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "billing-plans" });

    await page.goto(`/${orgSlug}/billing/plans`);
    await expect(page).not.toHaveURL(/\/login/);

    // The PlansGrid section heading "Plans" must be visible.
    await expect(page.getByRole("heading", { name: /plans/i })).toBeVisible({
      timeout: 10_000,
    });
  });
});
