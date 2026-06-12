/**
 * GitHub source-connect start — regression for the cross-origin wizard path.
 *
 * The connection wizard fetches the Hono API (localhost:3000 → localhost:4000)
 * with `credentials: "include"`; before the API grew CORS middleware the
 * browser killed the very first preflight with "Failed to fetch" and the
 * wizard could never start. This spec drives the real button path:
 *
 *   sources page → wizard → POST /connections (cross-origin, credentialed)
 *   → GET /connections/github/auth-url → redirect to GitHub authorize URL
 *
 * Hermetic: github.com is never contacted — the OAuth navigation is
 * intercepted and stubbed, asserted by URL shape only.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test("GitHub connect wizard reaches the OAuth redirect (no failed-to-fetch)", async ({
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

  await page.goto(`/${user.orgSlug}/default/knowledge/sources`);
  await page.getByTestId("connect-github-btn").click();

  // Step 1 of the wizard: "Connect with GitHub" fires the credentialed
  // cross-origin POST that used to die in CORS preflight.
  const createResponse = page.waitForResponse(
    (res) =>
      res.url().includes("/connections") && res.request().method() === "POST",
  );
  const authUrlResponse = page.waitForResponse((res) =>
    res.url().includes("/connections/github/auth-url"),
  );
  await page.getByTestId("github-connect-btn").click();

  // Surface status + body on failure — a bare ok()=false told us nothing when
  // CI's API was missing INGESTION_ENCRYPTION_KEY and 500'd this POST.
  const createRes = await createResponse;
  expect(
    createRes.ok(),
    `POST /connections → ${createRes.status()}: ${await createRes.text().catch(() => "<no body>")}`,
  ).toBe(true);
  const authUrlRes = await authUrlResponse;
  expect(
    authUrlRes.ok(),
    `GET auth-url → ${authUrlRes.status()}: ${await authUrlRes.text().catch(() => "<no body>")}`,
  ).toBe(true);

  // The wizard hands off to GitHub's authorize page with the app client and
  // an HMAC-signed state param.
  await page.waitForURL(/github\.com\/login\/oauth\/authorize/);
  const authorizeUrl = new URL(page.url());
  expect(authorizeUrl.searchParams.get("client_id")).toBeTruthy();
  expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
});
