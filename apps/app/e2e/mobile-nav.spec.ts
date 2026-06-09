import { test, expect, devices } from "@playwright/test";
import {
  setupAgentRuntimeFixture,
  teardownFixture,
  type AgentRuntimeFixture,
} from "./helpers/agent-runtime-fixture";
import { loginWithSession } from "./helpers/auth";

// Viewport used: iPhone 14 Pro (390 × 844) — representative of the ≥390 px
// class where the mobile layout is active.

const MOBILE_VIEWPORT = devices["iPhone 14 Pro"].viewport;

const ORG_SLUG = "e2e-mobile-nav";
const WS_SLUG = "main";
const USER_EMAIL = "e2e+mobile-nav@oxagen.ai";

// Shared across both describe blocks — seeded once, torn down once.
let fixture: AgentRuntimeFixture;

test.beforeAll(async () => {
  fixture = await setupAgentRuntimeFixture({
    orgSlug: ORG_SLUG,
    workspaceSlug: WS_SLUG,
    userEmail: USER_EMAIL,
  });
});

test.afterAll(async () => {
  await teardownFixture({ orgSlug: ORG_SLUG });
});

test.describe("mobile-nav (< md viewport)", () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test("sidebar is not visible at mobile width", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixture.sessionToken, baseURL);
    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/ask`);
    // Sidebar is `hidden md:flex` — must not be visible at mobile width.
    const sidebar = page.locator("aside").first();
    await expect(sidebar).toBeHidden();
    // Confirm we reached the authenticated workspace shell, not the login page.
    await expect(page).not.toHaveURL(/\/login/);
  });

  test("mobile hamburger button is visible in topbar", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixture.sessionToken, baseURL);
    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/ask`);
    const trigger = page.getByRole("button", { name: /open navigation menu/i });
    await expect(trigger).toBeVisible();
    await expect(trigger).toBeEnabled();
  });

  test("mobile drawer opens and contains navigation links", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixture.sessionToken, baseURL);
    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/ask`);

    const trigger = page.getByRole("button", { name: /open navigation menu/i });
    await expect(trigger).toBeVisible();
    await trigger.click();

    // The nav drawer should open and expose primary nav links.
    const nav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(nav).toBeVisible();

    // At least one workspace nav link must be present.
    await expect(nav.getByRole("link", { name: /chat/i })).toBeVisible();
  });

  test("mobile bottom bar is visible at mobile width", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixture.sessionToken, baseURL);
    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/ask`);
    const bottomBar = page.getByRole("navigation", { name: /mobile navigation/i });
    await expect(bottomBar).toBeVisible();
    // Confirm authenticated shell rendered (not login redirect).
    await expect(page).not.toHaveURL(/\/login/);
  });
});

test.describe("mobile-nav hidden at desktop width", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("sidebar is visible at desktop width", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixture.sessionToken, baseURL);
    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/ask`);
    // Desktop sidebar should be rendered and visible (md:flex).
    const sidebar = page.locator("aside").first();
    await expect(sidebar).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
  });

  test("mobile hamburger button is hidden at desktop width", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixture.sessionToken, baseURL);
    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/ask`);
    const trigger = page.getByRole("button", { name: /open navigation menu/i });
    await expect(trigger).toBeHidden();
    // Sidebar visible confirms the desktop layout rendered correctly.
    await expect(page.locator("aside").first()).toBeVisible();
  });
});
