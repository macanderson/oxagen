/**
 * cli-complete.spec.ts — the page the CLI's loopback listener sends the
 * browser to once `oxagen login` holds its token.
 *
 * It must render without a session: the browser that finished the consent
 * flow may not hold the app cookie, and a bounce to /login here would end a
 * successful login on a sign-in form.
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored).
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
  "cli-complete",
);

test.beforeAll(() => {
  fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test("/cli/complete renders the login-complete card without a session", async ({
  page,
}) => {
  await page.goto("/cli/complete");
  await expect(page).toHaveURL(/\/cli\/complete$/);
  await expect(
    page.getByRole("heading", { name: "Login complete" }),
  ).toBeVisible();
  await expect(
    page.getByText(/close this tab and return to your terminal/i),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "cli-complete.png"),
    fullPage: true,
  });
});
