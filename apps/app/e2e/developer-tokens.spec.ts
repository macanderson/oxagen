/**
 * developer-tokens.spec.ts — e2e proof for the org Developer → Tokens surface.
 *
 * Drives /{orgSlug}/developer/tokens through the full API-key lifecycle for a
 * fresh org (the signup creator is org owner, so the assertOrgAdmin gate in
 * api-key.ts passes):
 *   1. Empty state renders before any key exists.
 *   2. Create → the raw key is shown exactly once with the "won't be shown
 *      again" warning → the key row appears (masked) under "Active".
 *   3. Rotate → api.key.rotate atomically issues a NEW key (new raw secret
 *      shown once) and revokes the OLD one in the same call — see
 *      packages/oxagen/src/contracts/api.key.rotate.ts. The old key moves to
 *      "Revoked / expired"; exactly one key stays active.
 *   4. Revoke the (now sole) active key → it too moves to "Revoked / expired";
 *      no active key remains.
 *
 * Proves: create_api_key, revoke_api_key, rotate_api_key (capability-ui-map).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";

test("developer tokens: create, rotate, and revoke an API key end-to-end", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "e2e-tokens" });

  await gotoStable(page, `/${orgSlug}/developer/tokens`);
  await expect(page).not.toHaveURL(/\/login/);

  await expect(
    page.getByRole("heading", { name: "API tokens", level: 3 }),
  ).toBeVisible({ timeout: 15_000 });

  // ── 1. Empty state ────────────────────────────────────────────────────────
  await expect(
    page.getByText("No API tokens yet. Create one above to get started."),
  ).toBeVisible();

  // ── 2. Create a key — raw key shown exactly once ───────────────────────────
  await page.getByRole("button", { name: "Create token" }).click();
  await page.getByLabel("Token name").fill("e2e key");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await expect(
    page.getByText("Copy your token now — it won't be shown again"),
  ).toBeVisible({ timeout: 10_000 });
  const rawKeyCode = page.locator("code");
  await expect(rawKeyCode).toBeVisible();
  const firstRawKey = await rawKeyCode.innerText();
  expect(firstRawKey.length).toBeGreaterThan(10);

  await expect(
    page.getByText("No API tokens yet. Create one above to get started."),
  ).toHaveCount(0);
  await expect(page.getByText("e2e key")).toBeVisible();
  const rotateButton = page.getByRole("button", { name: "Rotate" });
  await expect(rotateButton).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(1);

  // ── 3. Rotate — a new raw key is shown once; the old key is now revoked ────
  await rotateButton.click();

  await expect(
    page.getByText("Copy your token now — it won't be shown again"),
  ).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => rawKeyCode.innerText(), { timeout: 10_000 })
    .not.toBe(firstRawKey);

  // Rotation replaces the secret but keeps exactly one key active — the old
  // secret's row moves into "Revoked / expired" alongside it.
  await expect(page.getByRole("button", { name: "Rotate" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(1);
  await expect(page.getByText("Revoked", { exact: true })).toHaveCount(1);

  // ── 4. Revoke the (new) active key — confirmation required ─────────────────
  await page.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByRole("button", { name: "Rotate" })).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  await expect(page.getByText("Revoked", { exact: true })).toHaveCount(2);
});
