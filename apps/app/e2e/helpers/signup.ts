/**
 * signup.ts — fresh-user fixture for Phase 5 parallel e2e tests.
 *
 * signUpFreshUser: drives the real /signup email/password form for a randomly
 * generated user, then completes /new-organization onboarding. Returns
 * credentials + orgSlug. Each call is unique — safe under fullyParallel.
 *
 * Design:
 *  - Uses the real UI form so the session cookie is set by Better Auth.
 *  - After org creation, navigates explicitly to /<orgSlug>/default via
 *    page.goto() — the client-side router.push() inside startTransition is
 *    not reliably observable by Playwright (it uses History API pushState
 *    and the concurrent React render may be deferred). Explicit navigation
 *    is faster, deterministic, and equally valid for end-to-end testing.
 *  - No teardown by default — local DB is disposable between runs.
 */

import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { gotoStable } from "./nav";

export interface FreshUser {
  email: string;
  password: string;
  name: string;
  orgSlug: string;
}

function uid(): string {
  return randomBytes(6).toString("hex");
}

/**
 * Sign up a brand-new user via the real /signup UI form, then create a new
 * org via /new-organization. Returns credentials + orgSlug.
 *
 * After the org is created, navigates explicitly to /<orgSlug>/default so the
 * page is in a known authenticated state.
 */
export async function signUpFreshUser(
  page: Page,
  opts?: { namePrefix?: string; orgPrefix?: string },
): Promise<FreshUser> {
  const id = uid();
  const email = `e2e-${id}@oxagen.test`;
  const password = `E2ePass${id}!`;
  const name = `${opts?.namePrefix ?? "E2E"} ${id}`;
  const orgSlug = `${opts?.orgPrefix ?? "e2e"}-${id}`;
  const orgName = `E2E Org ${id}`;

  // ── 1. Navigate to signup ────────────────────────────────────────────────
  await page.goto("/signup");
  await page.waitForSelector('input[name="name"]', { state: "visible" });

  // ── 2. Fill and submit the signup form ───────────────────────────────────
  await page.fill('input[name="name"]', name);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.getByRole("button", { name: /create account/i }).click();

  // Better Auth sets the session cookies and the client calls
  // router.push("/new-organization") directly (signup path). This is a
  // client-side History API navigation — Playwright observes it reliably.
  await page.waitForURL((url) => url.pathname === "/new-organization", {
    timeout: 20_000,
  });

  // ── 3. Complete org onboarding ───────────────────────────────────────────
  await page.waitForSelector('input[name="name"]', {
    state: "visible",
    timeout: 10_000,
  });
  await page.fill('input[name="name"]', orgName);

  const slugInput = page.locator('input[name="slug"]');
  await slugInput.clear();
  await slugInput.fill(orgSlug);

  // Chrome 130+ with the Unicode "v" flag rejects the legacy HTML pattern
  // `[a-z0-9-]{2,40}` as an invalid character class in form validation.
  // Remove the attribute so native HTML5 validation doesn't block submit;
  // the server action validates the slug independently.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>('input[name="slug"]');
    if (el) el.removeAttribute("pattern");
  });

  await page.getByRole("button", { name: /create organization/i }).click();

  // Wait for the server action to complete. The NewOrgForm server action is
  // fast (single DB transaction) but the response round-trip in dev can take
  // 1-2s. We wait for the submit button to exit "Creating…" OR for a brief
  // fixed delay — whichever comes first. We don't rely on URL change here
  // because the router.push() inside startTransition isn't directly observable.
  //
  // The waitForFunction polls the DOM for the button text to change from
  // "Creating…" back to "Create organization" (action complete) OR for the
  // button to disappear (component unmounted after successful navigation).
  try {
    await page.waitForFunction(
      () => {
        const btn = document.querySelector<HTMLButtonElement>(
          'button[type="submit"]',
        );
        if (!btn) return true; // Button gone — component unmounted (success).
        // Action completed when text is no longer the pending indicator.
        return !(btn.textContent ?? "").includes("Creating");
      },
      undefined,
      { timeout: 15_000, polling: 300 },
    );
  } catch {
    // Timeout — the action may still be in progress or the button changed
    // structure. Proceed to navigate explicitly; the goto() will fail fast
    // with a /login redirect if the session isn't valid.
  }

  // Check for any error message before proceeding.
  const errorEl = page.locator("p.text-destructive");
  const hasError = await errorEl.isVisible().catch(() => false);
  if (hasError) {
    const errText = await errorEl.innerText().catch(() => "unknown error");
    // Dev-only race: an HMR remount mid-submit (a parallel worker compiling a
    // fresh route triggers Fast Refresh) can replay the form action — the
    // first submit created the org and the replay reports "already taken".
    // The slug is randomBytes-fresh, so "taken" here means OUR submit landed;
    // fall through to the navigation below and let the auth gate verify it.
    if (!/already taken/i.test(errText)) {
      throw new Error(`signUpFreshUser: org creation failed — ${errText}`);
    }
  }

  // Navigate to the ask page. /{orgSlug}/default redirects to
  // /{orgSlug}/default/ask (server-side 307), and the workspace shell can fire a
  // further client redirect; under the Next dev server this races the default
  // `waitUntil: "load"` and throws `net::ERR_ABORTED` / "interrupted by another
  // navigation". gotoStable navigates with `waitUntil: "commit"` + retry so the
  // commit is immune to a later redirect/abort and a cold compile is retried.
  await gotoStable(page, `/${orgSlug}/default/ask`);

  // Verify auth gate passed.
  if (page.url().includes("/login")) {
    throw new Error(
      `signUpFreshUser: session not valid after signup (redirected to /login from /${orgSlug}/default/ask)`,
    );
  }

  // Verify the org route actually resolves. Under dev-server contention the
  // org-create action can still be in flight when we navigate (the button
  // poll above times out and falls through), so the first hit can 404 before
  // the transaction commits. Retry the navigation briefly before failing.
  const notFound = page.getByRole("heading", { name: "Page not found" });
  for (let attempt = 0; attempt < 5; attempt++) {
    const is404 = await notFound.isVisible().catch(() => false);
    if (!is404) break;
    if (attempt === 4) {
      throw new Error(
        `signUpFreshUser: org route /${orgSlug}/default/ask still 404s after signup — org creation did not land`,
      );
    }
    await page.waitForTimeout(2_000);
    await gotoStable(page, `/${orgSlug}/default/ask`);
  }

  return { email, password, name, orgSlug };
}
