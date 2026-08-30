/**
 * billing-revenue.spec.ts — e2e for the Revenue / Reseller surface
 * (/{orgSlug}/billing/revenue), the "Stripe for agents" re-bill loop.
 *
 * Drives the page for a fresh org (whose creator is an owner = billing manager).
 * A brand-new org has no customers, plans, rules, runs, or connected Stripe key,
 * so this proves the empty states render end-to-end, then exercises the primary
 * create-customer flow and asserts the new account appears in the table.
 *
 * The data path (attribution, pricing, push) is covered by the billing/handler
 * unit tests; here we prove the app surface is wired and works.
 */

import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Per-spec subdirectory, NOT the shared `e2e/screenshots` root: the beforeAll
// below wipes this directory, and pointing several specs at the same root made
// each one delete the artifacts the previously-run specs had just captured.
const SCREENSHOT_DIR = resolve(__dirname, "screenshots", "billing-revenue");

test.beforeAll(() => {
  rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test("revenue: renders empty states + Stripe connect prompt for a fresh org", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "revenue" });

  await page.goto(`/${orgSlug}/billing/revenue`);
  await expect(page).not.toHaveURL(/\/login/);
  await page.waitForLoadState("domcontentloaded");

  // Page header + all four section cards render.
  await expect(page.getByText("Revenue", { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("stripe-connect-card")).toBeVisible();
  await expect(page.getByTestId("customers-card")).toBeVisible();
  await expect(page.getByTestId("price-plans-card")).toBeVisible();
  await expect(page.getByTestId("rules-card")).toBeVisible();
  await expect(page.getByTestId("runs-card")).toBeVisible();

  // Fresh org empty states.
  await expect(page.getByTestId("stripe-not-connected")).toBeVisible();
  await expect(page.getByTestId("customers-empty")).toBeVisible();
  await expect(
    page.getByText("No customer accounts yet — add your first customer."),
  ).toBeVisible();

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/revenue-empty.png`,
    fullPage: true,
  });
});

test("revenue: create a customer account and see it in the table", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, {
    orgPrefix: "revenue-create",
  });
  await page.goto(`/${orgSlug}/billing/revenue`);
  await page.waitForLoadState("domcontentloaded");

  // Open the inline add-customer form and fill it.
  await page.getByTestId("add-customer").click();
  await expect(page.getByTestId("customer-form")).toBeVisible();
  await page.getByTestId("customer-name-input").fill("Acme Reseller Customer");
  await page.getByTestId("customer-save").click();

  // The new account appears as a row and the empty state is gone.
  await expect(page.getByText("Acme Reseller Customer")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("customer-row").first()).toBeVisible();
  await expect(page.getByTestId("customers-empty")).toHaveCount(0);

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/revenue-customer-created.png`,
    fullPage: true,
  });
});
