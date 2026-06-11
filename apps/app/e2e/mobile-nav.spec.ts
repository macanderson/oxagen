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

  test("the top-left hamburger trigger is gone (bottom nav is the only nav)", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixture.sessionToken, baseURL);
    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/ask`);
    // The old hamburger drawer trigger was removed in favour of the bottom bar.
    await expect(
      page.getByRole("button", { name: /open navigation menu/i }),
    ).toHaveCount(0);
  });

  test("bottom bar is visible and navigates client-side to the right page", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixture.sessionToken, baseURL);
    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/ask`);

    const bottomBar = page.getByRole("navigation", { name: /mobile navigation/i });
    await expect(bottomBar).toBeVisible();

    // Tapping a destination routes to it.
    await bottomBar.getByRole("link", { name: "Knowledge" }).click();
    await expect(page).toHaveURL(new RegExp(`/${ORG_SLUG}/${WS_SLUG}/knowledge`));
  });

  test("More sheet exposes overflow destinations and the account control", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixture.sessionToken, baseURL);
    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/ask`);

    await page.getByRole("button", { name: /more navigation/i }).click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    // Overflow nav (Settings lives behind More) and the account control.
    await expect(sheet.getByRole("link", { name: "Settings" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /open account menu/i })).toBeVisible();
  });

  test("bottom bar does not cover the chat composer Send button", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixture.sessionToken, baseURL);
    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/ask`);

    const sendButton = page.getByRole("button", { name: /send message/i });
    await expect(sendButton).toBeVisible();
    const bottomBar = page.getByRole("navigation", { name: /mobile navigation/i });

    // The Send button must sit entirely above the fixed bottom bar — its bottom
    // edge cannot overlap the bar's top edge (this is the bug being fixed).
    const sendBox = await sendButton.boundingBox();
    const barBox = await bottomBar.boundingBox();
    expect(sendBox).not.toBeNull();
    expect(barBox).not.toBeNull();
    expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(barBox!.y + 1);
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

  test("bottom bar is hidden at desktop width", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixture.sessionToken, baseURL);
    await page.goto(`/${ORG_SLUG}/${WS_SLUG}/ask`);
    // The bottom bar is `md:hidden` — absent at desktop width.
    await expect(
      page.getByRole("navigation", { name: /mobile navigation/i }),
    ).toBeHidden();
    // Sidebar visible confirms the desktop layout rendered correctly.
    await expect(page.locator("aside").first()).toBeVisible();
  });
});
