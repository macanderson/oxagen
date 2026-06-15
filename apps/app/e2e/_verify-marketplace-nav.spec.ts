import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import path from "node:path";

// Throwaway verification: confirm the Marketplace nav link renders in the
// workspace sidebar directly under Studio, and routes to org settings/plugins.
test("workspace sidebar shows Marketplace under Studio", async ({ page }) => {
  const { orgSlug } = await signUpFreshUser(page);
  await page.goto(`/${orgSlug}/default/ask`);

  const studio = page.getByRole("link", { name: "Studio" });
  const marketplace = page.getByRole("link", { name: "Marketplace" });
  await expect(studio).toBeVisible({ timeout: 15_000 });
  await expect(marketplace).toBeVisible();
  await expect(marketplace).toHaveAttribute("href", `/${orgSlug}/settings/plugins`);

  await page.screenshot({
    path: path.resolve(import.meta.dirname, "screenshots", "99-marketplace-nav.png"),
  });
});
