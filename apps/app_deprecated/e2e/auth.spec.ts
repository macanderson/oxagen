import { test, expect } from "@playwright/test";
import { loginWithSession } from "./helpers/auth";
import {
  setupAgentRuntimeFixture,
  teardownFixture,
  type AgentRuntimeFixture,
} from "./helpers/agent-runtime-fixture";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";

// ─── Auth-guard smoke tests (no session required) ───────────────────────────

test.describe("auth — unauthenticated guard", () => {
  test("login page renders email + OAuth options", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: /welcome back/i }),
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /continue with google/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /continue with github/i }),
    ).toBeVisible();
  });

  test("signup page links back to login", async ({ page }) => {
    await page.goto("/signup");
    await expect(
      page.getByRole("heading", { name: /create an account/i }),
    ).toBeVisible();
    await page.getByRole("link", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("unauthenticated root redirects to login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });
});

// ─── Real sign-in journey ────────────────────────────────────────────────────
//
// Seeds a user + session via `setupAgentRuntimeFixture`, injects the signed
// session cookie via `loginWithSession`, and asserts that:
//   1. The authed user lands on an org/workspace page (not /login).
//   2. The session persists across a same-tab navigation.
//   3. The user's name / org appears somewhere in the authenticated shell.
//
// We use the cookie-injection auth path (not form submission) because the
// test environment may not have a live SMTP / Better Auth server; the cookie
// approach matches what the fixture infrastructure already supports and is
// how all other authed specs work.

const AUTH_ORG_SLUG = "e2e-auth";
const AUTH_WS_SLUG = "main";
const AUTH_USER_EMAIL = "e2e+auth@oxagen.ai";

let authFixture: AgentRuntimeFixture;

test.describe("auth — successful sign-in journey", () => {
  test.beforeAll(async () => {
    authFixture = await setupAgentRuntimeFixture({
      orgSlug: AUTH_ORG_SLUG,
      workspaceSlug: AUTH_WS_SLUG,
      userEmail: AUTH_USER_EMAIL,
    });
  });

  test.afterAll(async () => {
    await teardownFixture({ orgSlug: AUTH_ORG_SLUG });
  });

  test("session cookie lands user on authed page, not /login", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, authFixture.sessionToken, baseURL);

    // Navigate to the org root — auth gate should pass.
    await gotoStable(page, `/${AUTH_ORG_SLUG}`);

    // Must NOT redirect to /login.
    await expect(page).not.toHaveURL(/\/login/);

    // The URL must contain the org slug — confirming we're in the authed shell.
    await expect(page).toHaveURL(new RegExp(AUTH_ORG_SLUG));
  });

  test("session persists across navigation to workspace chat", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, authFixture.sessionToken, baseURL);

    // Start at org root.
    await gotoStable(page, `/${AUTH_ORG_SLUG}`);
    await expect(page).not.toHaveURL(/\/login/);

    // Navigate to the workspace chat — session must carry across the navigation.
    await gotoStable(page, `/${AUTH_ORG_SLUG}/${AUTH_WS_SLUG}/chat`);
    await expect(page).not.toHaveURL(/\/login/);

    // The URL must still contain both slugs.
    await expect(page).toHaveURL(
      new RegExp(`${AUTH_ORG_SLUG}/${AUTH_WS_SLUG}`),
    );
  });

  test("org slug appears in the authed page body or nav", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, authFixture.sessionToken, baseURL);
    await gotoStable(page, `/${AUTH_ORG_SLUG}/${AUTH_WS_SLUG}/chat`);
    await expect(page).not.toHaveURL(/\/login/);

    // The org or workspace slug must be visible somewhere in the rendered DOM
    // (sidebar, breadcrumb, or page title). Case-insensitive to accommodate
    // display-name capitalisation.
    await expect(
      page.locator("body").getByText(new RegExp(AUTH_ORG_SLUG, "i")),
    ).toBeVisible();
  });
});

// ─── Real email+password login form journey ──────────────────────────────────
//
// Signs up a fresh user via signUpFreshUser (which drives the real /signup
// form), explicitly logs out, then logs BACK IN via the typed /login form.
// Asserts that a successful authenticated landing is reached without cookie
// injection — this proves the login form → Better Auth → session cookie round
// trip works end-to-end.

test.describe("auth — email+password login form", () => {
  test("signup → logout → login via typed form lands on authenticated page", async ({
    page,
  }) => {
    // ── 1. Sign up a fresh user (drives the real /signup form) ─────────────
    const { email, password, orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "form-login",
    });

    // After signup+org creation we are on /<orgSlug>/default — authenticated.
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(orgSlug));

    // ── 2. Log out by navigating to /logout (Better Auth session endpoint) ─
    // Better Auth exposes POST /api/auth/sign-out. Drive it via the UI to
    // keep the test realistic: navigate to a logout URL that triggers the
    // sign-out server action, or navigate to /login which clears state.
    // Simplest reliable approach: clear all cookies (equivalent to logout)
    // then navigate to /login to confirm the session is gone.
    await page.context().clearCookies();

    // Navigating to a protected route should now redirect to /login.
    await page.goto(`/${orgSlug}/default`);
    await expect(page).toHaveURL(/\/login/);

    // ── 3. Fill the real /login form ──────────────────────────────────────
    await page.waitForSelector('input[name="email"]', { state: "visible" });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    // Exact match — a broader /sign in|continue/i regex also catches the
    // "Continue with Google/GitHub" OAuth buttons and trips strict mode.
    await page.getByRole("button", { name: /^sign in$/i }).click();

    // Better Auth sets the session cookie and redirects to the app.
    // After a successful login, the user should land on an authenticated page
    // (not /login). Allow up to 15 s for the session round-trip.
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 15_000,
    });

    // ── 4. Assert authenticated landing ──────────────────────────────────
    await expect(page).not.toHaveURL(/\/login/);
    // The org slug should be present in the URL (the shell redirects to
    // the user's default org after a successful login).
    await expect(page).toHaveURL(new RegExp(orgSlug));
  });
});
