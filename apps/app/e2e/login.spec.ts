// The sign-in journey (ARCHITECTURE.md §6.3): the proxy's session gate sends
// an anonymous visitor to /login with the page kept as `next`; a Better Auth
// credential sign-in lands on that page on a production build; the context's
// storage state is saved for the page-load and pay projects.
import { expect, test } from "@playwright/test";
import authCatalog from "../messages/auth.json" with { type: "json" };
import { FLEET_PATH, OWNER_STATE, SEED } from "./support";

const copy = authCatalog.auth.login;

test("an anonymous visit is gated, the seeded owner signs in and lands on the workspace", async ({
  page,
}) => {
  await page.goto(FLEET_PATH);
  await expect(page).toHaveURL((url) => url.pathname === "/login");
  expect(new URL(page.url()).searchParams.get("next")).toBe(FLEET_PATH);

  const form = page.getByRole("form", { name: copy.title });
  await form.locator("#login-email").fill(SEED.email);
  await form.locator("#login-password").fill(SEED.password);
  await form.getByRole("button", { name: copy.submit }).click();

  await expect(page).toHaveURL((url) => url.pathname === FLEET_PATH, {
    timeout: 30_000,
  });
  await page.context().storageState({ path: OWNER_STATE });
});
