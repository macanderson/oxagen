/**
 * GitHub connect start — workspace-settings install + sources gate.
 *
 * The Oxagen GitHub App install now lives in Workspace Settings → GitHub
 * (1 workspace = 1 app install); the Sources tab no longer installs the App, it
 * only points the user to settings and then selects repos to ingest.
 *
 * These specs drive the real button paths and assert the cross-origin,
 * credentialed fetch path the wizard/panel rely on (localhost:3000 →
 * localhost:4000) — the same path that, before the API grew CORS middleware,
 * died in preflight with "Failed to fetch".
 *
 * Hermetic: github.com is never contacted — the OAuth navigation is intercepted
 * and stubbed, asserted by URL shape only.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test("Settings → GitHub connect reaches the OAuth redirect with signed state (no failed-to-fetch)", async ({
  page,
}) => {
  const user = await signUpFreshUser(page);

  // Stub the external OAuth navigation so the test never leaves localhost.
  await page.route("https://github.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>github-oauth-stub</title>",
    }),
  );

  // The panel fetches GET /connections/github/status on mount — the credentialed
  // cross-origin GET that used to die in CORS preflight.
  const statusResponse = page.waitForResponse((res) =>
    res.url().includes("/connections/github/status"),
  );
  await page.goto(`/${user.orgSlug}/default/settings/github`);

  const statusRes = await statusResponse;
  expect(
    statusRes.ok(),
    `GET status → ${statusRes.status()}: ${await statusRes.text().catch(() => "<no body>")}`,
  ).toBe(true);

  // A fresh workspace has never connected GitHub → the Connect button shows.
  await page.getByTestId("github-disconnected").waitFor();
  await page.getByTestId("github-connect-btn").click();

  // The connect hands off to GitHub's OAuth redirect carrying our HMAC-signed
  // state (org/workspace attribution). The primary Connect uses the identity leg
  // (login/oauth/authorize) — which ALWAYS round-trips state even when the App is
  // already installed on the target org, unblocking a second tenant — and falls
  // back to the App installation page (installations/new) when no client id is
  // configured. Either way, our signed state must be present.
  await page.waitForURL(
    /github\.com\/(login\/oauth\/authorize|apps\/[^/]+\/installations\/new)/,
  );
  const redirectUrl = new URL(page.url());
  expect(redirectUrl.searchParams.get("state")).toBeTruthy();
});

test("Sources tab skips the install and points to Settings when GitHub is not connected", async ({
  page,
}) => {
  const user = await signUpFreshUser(page);

  await page.goto(`/${user.orgSlug}/default/knowledge/repos`);
  // Empty state → open the GitHub add-source wizard.
  await page.getByTestId("connect-github-btn").click();

  // With no install yet, the wizard does NOT offer to install — it gates to the
  // workspace settings GitHub page.
  await expect(page.getByTestId("github-install-gate")).toBeVisible();
  await expect(page.getByTestId("github-gate-settings-link")).toHaveAttribute(
    "href",
    new RegExp(`/${user.orgSlug}/default/settings/github`),
  );
});
