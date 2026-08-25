/**
 * billing-invoices.spec.ts — e2e proof for the org Billing → Invoices surface.
 *
 * A freshly-signed-up org has no Stripe-synced invoice rows yet (no billing
 * cycle has run), so this proves the empty state renders cleanly inside the
 * billing layout's tab strip, with no error — the read path that matters most
 * for this surface, per docs/web-app-2.0/org/billing/invoices/spec.md.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";

test("billing invoices: fresh org renders the empty state inside the billing tabs", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "e2e-inv" });

  await gotoStable(page, `/${orgSlug}/billing/invoices`);
  await expect(page).not.toHaveURL(/\/login/);

  await expect(
    page.getByRole("heading", { name: "Billing", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });

  const invoicesTab = page.getByRole("tab", { name: "Invoices" });
  await expect(invoicesTab).toBeVisible();
  await expect(invoicesTab).toHaveAttribute("aria-selected", "true");

  await expect(
    page.getByRole("heading", { name: "Invoices", level: 3 }),
  ).toBeVisible();
  // Asserted as the component renders it: the title carries no trailing
  // period, the description does. The spec looked for "No invoices yet." and
  // Playwright's substring match never found it, because that period is not in
  // the DOM. invoice-list.test.tsx asserts these same two strings, so the unit
  // test and this spec now agree about one component instead of contradicting.
  await expect(page.getByText("No invoices yet")).toBeVisible();
  await expect(
    page.getByText("Invoices appear here after your first billing cycle."),
  ).toBeVisible();
});
