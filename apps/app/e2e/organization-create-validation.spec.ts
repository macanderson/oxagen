/**
 * organization.create.validation — e2e spec.
 *
 * Covers the error paths that organization-create.spec.ts omits:
 *  (a) Submitting a slug that is already taken → server action returns an error
 *      and the error message renders in the form.
 *  (b) An invalid slug (too short / bad chars) → server-side validation rejects
 *      it and the error message renders.
 *
 * Strategy:
 *  - signUpFreshUser drives the real signup flow and creates the first org,
 *    occupying its slug in the DB.
 *  - We then sign up a SECOND fresh user (parallel-safe), navigate to
 *    /new-organization, and attempt to reuse the first org's slug.
 *  - For the invalid-slug path a single user is sufficient.
 *
 * We do NOT reuse the signup helper's org-creation sub-step because we need to
 * control the slug submitted to the form. Instead we navigate to
 * /new-organization manually after signing up and fill the form ourselves.
 */

import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";

// ── Helper: sign up a user but stop before creating the org ──────────────────

function uid(): string {
  return randomBytes(5).toString("hex");
}

async function signUpOnly(
  page: Page,
  opts?: { namePrefix?: string },
): Promise<{ email: string; password: string }> {
  const id = uid();
  const email = `e2e-val-${id}@oxagen.test`;
  const password = `E2eVal${id}!`;
  const name = `${opts?.namePrefix ?? "Val"} ${id}`;

  await page.goto("/signup");
  await page.waitForSelector('input[name="name"]', { state: "visible" });
  await page.fill('input[name="name"]', name);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.getByRole("button", { name: /create account/i }).click();

  // After signup Better Auth redirects to /new-organization.
  await page.waitForURL((url) => url.pathname === "/new-organization", {
    timeout: 20_000,
  });

  return { email, password };
}

// ── Helper: fill the /new-organization form with given name + slug ─────────────

async function fillOrgForm(
  page: Page,
  orgName: string,
  orgSlug: string,
): Promise<void> {
  await page.waitForSelector('input[name="name"]', {
    state: "visible",
    timeout: 10_000,
  });
  await page.fill('input[name="name"]', orgName);
  const slugInput = page.locator('input[name="slug"]');
  await slugInput.clear();
  await slugInput.fill(orgSlug);

  // Remove the pattern attribute to prevent browser-native HTML5 validation
  // from blocking the submit (the same workaround used in signup.ts).
  await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>('input[name="slug"]');
    if (el) el.removeAttribute("pattern");
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) Duplicate-slug path
// ─────────────────────────────────────────────────────────────────────────────

test.describe("organization.create.validation — duplicate slug", () => {
  test("submitting an already-taken slug shows a conflict error in the form", async ({
    page,
    browser,
  }) => {
    // ── User A: create an org to occupy a slug ──────────────────────────────
    const takenSlug = `e2e-dup-${uid()}`;
    const takenOrgName = `E2E Dup Org ${uid()}`;

    await signUpOnly(page);
    await fillOrgForm(page, takenOrgName, takenSlug);
    await page.getByRole("button", { name: /create organization/i }).click();

    // Wait for org creation to complete (button exits "Creating…" or disappears).
    await page.waitForFunction(
      () => {
        const btn = document.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (!btn) return true;
        return !(btn.textContent ?? "").includes("Creating");
      },
      undefined,
      { timeout: 15_000, polling: 300 },
    ).catch(() => {/* tolerate timeout — slug may have been created anyway */});

    // ── User B: attempt to reuse the same slug ──────────────────────────────
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    try {
      await signUpOnly(pageB, { namePrefix: "DupB" });
      await fillOrgForm(pageB, "Another Org Name", takenSlug);
      await pageB.getByRole("button", { name: /create organization/i }).click();

      // Wait for the server action to return an error.
      const errorLocator = pageB.locator("p.text-destructive");
      await expect(errorLocator).toBeVisible({ timeout: 12_000 });

      // The error must mention "taken", "exists", "conflict", or "already".
      await expect(errorLocator).toContainText(
        /taken|exists|conflict|already|in use/i,
        { timeout: 5_000 },
      );

      // The form must still be visible (not navigated away).
      await expect(pageB).toHaveURL(/\/new-organization/);
    } finally {
      await contextB.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Invalid-slug path
// ─────────────────────────────────────────────────────────────────────────────

test.describe("organization.create.validation — invalid slug", () => {
  test("submitting a slug that is too short returns a validation error", async ({
    page,
  }) => {
    await signUpOnly(page, { namePrefix: "InvalidSlug" });

    // Slug "x" is only 1 character — below the 2-char minimum enforced by
    // the server action.
    await fillOrgForm(page, "Valid Org Name", "x");
    await page.getByRole("button", { name: /create organization/i }).click();

    // The server action validates the slug before touching the DB.
    const errorLocator = page.locator("p.text-destructive");
    await expect(errorLocator).toBeVisible({ timeout: 12_000 });
    await expect(errorLocator).toContainText(
      /slug|invalid|character|length|short|2/i,
      { timeout: 5_000 },
    );

    // Still on the org-creation page.
    await expect(page).toHaveURL(/\/new-organization/);
  });

  test("submitting a slug with disallowed characters returns a validation error", async ({
    page,
  }) => {
    await signUpOnly(page, { namePrefix: "BadChars" });

    // Uppercase and spaces are not valid in a slug.
    await fillOrgForm(page, "Valid Org Name", "Invalid Slug!!!");
    await page.getByRole("button", { name: /create organization/i }).click();

    const errorLocator = page.locator("p.text-destructive");
    await expect(errorLocator).toBeVisible({ timeout: 12_000 });
    await expect(errorLocator).toContainText(
      /slug|invalid|character|format|lowercase/i,
      { timeout: 5_000 },
    );

    await expect(page).toHaveURL(/\/new-organization/);
  });
});
