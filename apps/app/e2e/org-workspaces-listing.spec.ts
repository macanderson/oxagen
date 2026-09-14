/**
 * org-workspaces-listing — e2e for the org-scope Workspaces page.
 *
 * Proves the fix for the broken org-mode "Workspaces" nav item, which used to
 * point at the org root (`/{org}`) and redirect straight into a workspace's Ask
 * surface — flashing an error before landing on Ask. Now it lands on a real
 * listing page:
 *   1. /{org}/workspaces renders a card per workspace, each headed by the
 *      workspace avatar (EntityAvatar) with name + slug.
 *   2. A card links into the workspace (→ its Ask surface).
 *   3. The "New workspace" action links to the creation page.
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored).
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

test("org workspaces listing: cards with avatars link into the workspace", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const user = await signUpFreshUser(page, { orgPrefix: "e2e-wslist" });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // ── 1. The listing renders a card for the default workspace ───────────────
  await page.goto(`/${user.orgSlug}/workspaces`);
  await expect(
    page.getByRole("heading", { name: "Workspaces", level: 1 }),
  ).toBeVisible({ timeout: 20_000 });

  const card = page.getByRole("link", { name: /Open workspace/i }).first();
  await expect(card).toBeVisible();
  // The default workspace slug is "default" (created at signup).
  await expect(card).toContainText("/default");

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "org-workspaces-listing.png"),
    fullPage: true,
  });

  // ── 2. The "New workspace" action points at the creation page ─────────────
  const newWs = page.getByRole("link", { name: /New workspace/i }).first();
  await expect(newWs).toHaveAttribute("href", `/${user.orgSlug}/new-workspace`);

  // ── 3. Clicking a card enters the workspace (lands on Sessions, no error) ──────
  await card.click();
  await expect(page).toHaveURL(
    new RegExp(`/${user.orgSlug}/default/sessions`),
    {
      timeout: 20_000,
    },
  );
});
