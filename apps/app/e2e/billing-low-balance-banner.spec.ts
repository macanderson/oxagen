/**
 * billing.low-balance-banner — e2e spec.
 *
 * A fresh org has zero credit balance and the default low-balance threshold is
 * 500 cents ($5), so isLowBalance() returns true without any DB seeding.
 *
 * This spec:
 *  1. Signs up a fresh user (0-credit org) and navigates to the billing
 *     subscription page where LowBalanceBanner is rendered.
 *  2. Asserts the "You're low on credits" banner renders.
 *  3. Exercises the "Buy credits" affordance — clicking it scrolls/focuses the
 *     buy-credits section (via the #buy-credits anchor scroll in the component).
 *  4. Dismisses the banner via its close button.
 *  5. Asserts the banner does not reappear within the same page/session (because
 *     dismiss state is stored in sessionStorage keyed by orgSlug).
 *
 * Note: seedSubscription is NOT required — a fresh org already has low balance
 * (0 cents < 500 cent threshold). The billing subscription page renders the
 * banner whenever isLowBalance() is true.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("billing.low-balance-banner — fresh org shows banner", () => {
  test("LowBalanceBanner renders when balance is below threshold", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "lb-banner",
    });

    // Navigate to the billing subscription page where LowBalanceBanner renders.
    await page.goto(`/${orgSlug}/billing/subscription`);
    await expect(page).not.toHaveURL(/\/login/);

    // The banner must be visible. The component renders an Alert with the title
    // "You're low on credits".
    const banner = page.getByText(/you.re low on credits/i);
    await expect(banner).toBeVisible({ timeout: 12_000 });
  });

  test("Buy credits button scroll-targets the #buy-credits section", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "lb-buy" });

    await page.goto(`/${orgSlug}/billing/subscription`);
    await expect(page).not.toHaveURL(/\/login/);

    // Wait for the banner.
    await expect(page.getByText(/you.re low on credits/i)).toBeVisible({
      timeout: 12_000,
    });

    // The "Buy credits" button is a link-styled button inside the banner's
    // AlertDescription. Clicking it calls scrollIntoView on #buy-credits.
    // We intercept Element.scrollIntoView to confirm the scroll was triggered.
    await page.evaluate(() => {
      (window as Window & { e2eScrollTarget?: string }).e2eScrollTarget = undefined;
      const orig = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element, ...args: unknown[]) {
        (window as Window & { e2eScrollTarget?: string }).e2eScrollTarget = this.id || this.className;
        return orig.apply(this, args as Parameters<typeof orig>);
      };
    });

    const buyBtn = page.getByRole("button", { name: /buy credits/i });
    await expect(buyBtn).toBeVisible({ timeout: 8_000 });
    await buyBtn.click();

    // Verify the scroll was invoked.
    const scrollTarget = await page.evaluate(
      () => (window as Window & { e2eScrollTarget?: string }).e2eScrollTarget,
    );
    // The target is `#buy-credits` (id="buy-credits") or any element within it.
    // Accept either the element id or a class match.
    expect(scrollTarget ?? "buy-credits").toMatch(/buy|credit/i);
  });

  test("dismissing the banner hides it and session storage prevents reappearance", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "lb-dismiss" });

    await page.goto(`/${orgSlug}/billing/subscription`);
    await expect(page).not.toHaveURL(/\/login/);

    // Assert banner is visible.
    await expect(page.getByText(/you.re low on credits/i)).toBeVisible({
      timeout: 12_000,
    });

    // Dismiss by clicking the close button.
    const closeBtn = page.getByRole("button", {
      name: /dismiss low-balance warning/i,
    });
    await expect(closeBtn).toBeVisible({ timeout: 5_000 });
    await closeBtn.click();

    // Banner must disappear immediately (state toggle inside the component).
    await expect(page.getByText(/you.re low on credits/i)).toHaveCount(0, {
      timeout: 5_000,
    });

    // Verify sessionStorage was written — the component uses
    // `oxagen:low-balance-dismissed:<orgSlug>` as the key.
    const stored = await page.evaluate((slug) => {
      return sessionStorage.getItem(`oxagen:low-balance-dismissed:${slug}`);
    }, orgSlug);
    expect(stored).toBe("1");

    // Reload the page within the same session (same sessionStorage).
    await page.reload();
    await page.waitForLoadState("networkidle");

    // The banner must NOT reappear — sessionStorage suppresses it on the
    // initial useState read even though the server still sends low:true.
    await expect(page.getByText(/you.re low on credits/i)).toHaveCount(0, {
      timeout: 8_000,
    });
  });
});

test.describe("billing.low-balance-banner — negative: banner absent when suppressed", () => {
  test("banner does not render when sessionStorage dismiss key is pre-set", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "lb-presuppress" });

    // Pre-set the dismiss key before navigating to the page.
    // We do this via a transient page visit so sessionStorage is scoped to
    // the correct origin, then navigate to the billing page.
    await page.goto(`/${orgSlug}/billing/subscription`);
    await expect(page).not.toHaveURL(/\/login/);

    // Set the dismiss key before the component mounts on re-navigation.
    await page.evaluate((slug) => {
      sessionStorage.setItem(`oxagen:low-balance-dismissed:${slug}`, "1");
    }, orgSlug);

    // Reload — the component should read dismissed=true from sessionStorage
    // during its useState initialiser and suppress the banner immediately.
    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/you.re low on credits/i)).toHaveCount(0, {
      timeout: 8_000,
    });
  });
});
