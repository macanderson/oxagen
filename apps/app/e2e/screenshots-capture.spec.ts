/**
 * Screenshot capture script — takes screenshots of the newly built pages.
 * Run with: npx playwright test --config e2e/screenshots.config.ts
 */
import { test } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = resolve(__dirname, "screenshots");

// Load credentials from monorepo root creds.json
const creds = JSON.parse(
  readFileSync(resolve(__dirname, "../../../creds.json"), "utf8"),
);
const BASE = creds.app.url;
const ORG = creds.org.slug;
const WS = creds.workspace.slug;
const EMAIL = creds.user.email;
const PASSWORD = creds.user.password;

// Login helper — drive the login form using creds.json
async function login(page: import("@playwright/test").Page) {
  await page.goto(`${BASE}${creds.app.loginPath}`);
  await page.waitForLoadState("networkidle");

  // Fill email field
  const emailInput = page.locator('input[type="email"], input[name="email"]');
  await emailInput.fill(EMAIL);

  // Fill password field
  const passwordInput = page.locator(
    'input[type="password"], input[name="password"]',
  );
  await passwordInput.fill(PASSWORD);

  // Submit form
  await page.locator('button[type="submit"]').click();

  // Wait for redirect away from login
  await page.waitForURL((url) => !url.pathname.includes("/login"), {
    timeout: 15000,
  });
  // Wait for app to stabilize
  await page.waitForLoadState("networkidle");
}

test.describe("Page Screenshots", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("Developer Tokens page", async ({ page }) => {
    await page.goto(`${BASE}/${ORG}/developer/tokens`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-developer-tokens.png`,
      fullPage: true,
    });
  });

  test("Settings Skills page", async ({ page }) => {
    await page.goto(`${BASE}/${ORG}/${WS}/studio/tools/skills`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-settings-skills.png`,
      fullPage: true,
    });
  });

  test("Settings page with sidebar nav", async ({ page }) => {
    await page.goto(`${BASE}/${ORG}/${WS}/settings/general`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/05-settings-sidebar-nav.png`,
      fullPage: true,
    });
  });
});
