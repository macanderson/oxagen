/**
 * workspace.add-second — e2e spec.
 *
 * An authenticated user navigates to /{orgSlug}/new-workspace, fills in the
 * workspace name and slug, submits the form, and asserts:
 *  1. The browser navigates to the new workspace chat page.
 *  2. The new workspace name appears in the workspace switcher.
 *
 * This is distinct from workspace-create.spec.ts, which only asserts the
 * default workspace created during onboarding is reachable.
 *
 * Gap covered: no existing spec exercises creating an additional workspace
 * after onboarding, nor verifies the switcher updates to reflect the new one.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { randomBytes } from "node:crypto";

function uid(): string {
  return randomBytes(4).toString("hex");
}

test.describe("workspace.add-second — create a second workspace", () => {
  test("navigating to /new-workspace and submitting creates the workspace and lands in it", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "ws-add" });

    const newWsName = `Second Ws ${uid()}`;
    const newWsSlug = `ws-second-${uid()}`;

    // Navigate to the new-workspace creation page.
    await page.goto(`/${orgSlug}/new-workspace`);
    await expect(page).not.toHaveURL(/\/login/);

    // The form renders.
    const nameInput = page.getByLabel(/workspace name/i);
    await expect(nameInput).toBeVisible({ timeout: 10_000 });

    // Fill in name — the slug auto-populates from the name.
    await nameInput.fill(newWsName);

    // Override the auto-generated slug with our deterministic one so we can
    // assert the URL after creation.
    const slugInput = page.getByLabel(/^slug/i);
    await expect(slugInput).toBeVisible();
    await slugInput.clear();
    await slugInput.fill(newWsSlug);

    // Remove the `pattern` attribute to bypass browser-native HTML5 validation
    // (same guard used in signup.ts for the org slug).
    await page.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>('input[name="slug"]');
      if (el) el.removeAttribute("pattern");
    });

    // Submit the form.
    const createBtn = page.getByRole("button", { name: /create workspace/i });
    await expect(createBtn).toBeVisible();
    await createBtn.click();

    // NewWorkspaceForm uses window.location.assign for the post-creation
    // redirect, which Playwright observes as a full navigation.
    await page.waitForURL(
      (url) => url.pathname.includes(newWsSlug),
      { timeout: 20_000 },
    );

    // Must NOT be a login redirect.
    await expect(page).not.toHaveURL(/\/login/);

    // URL must contain both the org slug and the new workspace slug.
    const currentPath = new URL(page.url()).pathname;
    expect(currentPath).toContain(orgSlug);
    expect(currentPath).toContain(newWsSlug);
  });

  test("new workspace name appears in the workspace switcher", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "ws-switch",
    });

    const newWsName = `Switcher Ws ${uid()}`;
    const newWsSlug = `ws-sw-${uid()}`;

    await page.goto(`/${orgSlug}/new-workspace`);
    await expect(page).not.toHaveURL(/\/login/);

    const nameInput = page.getByLabel(/workspace name/i);
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    await nameInput.fill(newWsName);

    const slugInput = page.getByLabel(/^slug/i);
    await slugInput.clear();
    await slugInput.fill(newWsSlug);

    await page.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>('input[name="slug"]');
      if (el) el.removeAttribute("pattern");
    });

    await page.getByRole("button", { name: /create workspace/i }).click();

    // Wait for navigation to the new workspace.
    await page.waitForURL((url) => url.pathname.includes(newWsSlug), {
      timeout: 20_000,
    });

    // The workspace switcher should now display the newly created workspace name
    // (it is the active workspace and shown in the trigger button text), OR it
    // appears in the workspace menu when the user opens the switcher.
    //
    // The WorkspaceSwitcher trigger renders the current workspace name as a
    // <span class="truncate">...</span> inside the Menu trigger button.
    const switcherTrigger = page.getByRole("button", {
      name: new RegExp(newWsName, "i"),
    });

    // Wait for the workspace shell to fully render — the switcher is in the
    // content header and hydrates client-side.
    await expect(switcherTrigger).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("workspace.add-second — negative: duplicate slug in same org", () => {
  test("creating a workspace with an already-used slug shows an error", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "ws-dup" });

    // "default" is always created by onboarding — use it as the taken slug.
    const takenSlug = "default";

    await page.goto(`/${orgSlug}/new-workspace`);
    await expect(page).not.toHaveURL(/\/login/);

    const nameInput = page.getByLabel(/workspace name/i);
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    await nameInput.fill("Duplicate Workspace");

    const slugInput = page.getByLabel(/^slug/i);
    await slugInput.clear();
    await slugInput.fill(takenSlug);

    await page.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>('input[name="slug"]');
      if (el) el.removeAttribute("pattern");
    });

    await page.getByRole("button", { name: /create workspace/i }).click();

    // The server action must return an error (slug already exists in this org).
    const errorLocator = page.locator("p.text-destructive").first();
    await expect(errorLocator).toBeVisible({ timeout: 12_000 });

    // Still on the new-workspace page (no redirect on failure).
    await expect(page).toHaveURL(new RegExp(`${orgSlug}/new-workspace`));
  });
});
