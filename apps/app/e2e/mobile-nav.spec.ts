import { test, expect, devices } from "@playwright/test";

// NOTE: this test requires a running dev/prod server and an authenticated
// session with at least one org + workspace. It is written here for
// completeness per OXA-1427 and runs at integration time (not in-worktree).
//
// Viewport used: iPhone 14 Pro (390 × 844) — representative of the ≥390 px
// class where the mobile layout is active.

const MOBILE_VIEWPORT = devices["iPhone 14 Pro"].viewport;

test.describe("mobile-nav (< md viewport)", () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test("sidebar is not visible at mobile width", async ({ page }) => {
    await page.goto("/");
    // Sidebar is `hidden md:flex` — it should not be in the DOM / visible.
    const sidebar = page.locator("aside").first();
    await expect(sidebar).toBeHidden();
  });

  test("mobile hamburger button is visible in topbar", async ({ page }) => {
    await page.goto("/");
    // Redirect to login if unauthenticated — skip the nav assertion.
    if (page.url().includes("/login")) {
      test.skip();
      return;
    }
    const trigger = page.getByRole("button", { name: /open navigation menu/i });
    await expect(trigger).toBeVisible();
  });

  test("mobile drawer opens and contains navigation links", async ({ page }) => {
    await page.goto("/");
    if (page.url().includes("/login")) {
      test.skip();
      return;
    }
    const trigger = page.getByRole("button", { name: /open navigation menu/i });
    await trigger.click();

    // The Sheet (nav drawer) should be open and show nav links.
    const nav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(nav).toBeVisible();

    // At least one workspace nav link must be present.
    await expect(nav.getByRole("link", { name: /chat/i })).toBeVisible();
  });

  test("mobile bottom bar is visible at mobile width", async ({ page }) => {
    await page.goto("/");
    if (page.url().includes("/login")) {
      test.skip();
      return;
    }
    const bottomBar = page.getByRole("navigation", { name: /mobile navigation/i });
    await expect(bottomBar).toBeVisible();
  });
});

test.describe("mobile-nav hidden at desktop width", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("sidebar is visible at desktop width", async ({ page }) => {
    await page.goto("/");
    if (page.url().includes("/login")) {
      test.skip();
      return;
    }
    // Desktop sidebar should be rendered (md:flex).
    const sidebar = page.locator("aside").first();
    await expect(sidebar).toBeVisible();
  });

  test("mobile hamburger button is hidden at desktop width", async ({ page }) => {
    await page.goto("/");
    if (page.url().includes("/login")) {
      test.skip();
      return;
    }
    const trigger = page.getByRole("button", { name: /open navigation menu/i });
    await expect(trigger).toBeHidden();
  });
});
