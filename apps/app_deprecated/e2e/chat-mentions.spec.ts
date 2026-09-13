/**
 * chat @-mentions — e2e spec (UI-parity proof for `search_references`).
 *
 * Signs up a fresh user and drives the composer's @-mention picker end to
 * end: typing "@" opens the two-stage menu, the keyboard navigates and
 * filters reference types, picking "Capabilities" scopes a live
 * search_references lookup (the in-process capability registry — present on
 * every deployment, no seeded data needed), and selecting a result inserts a
 * readable "@Label" placeholder plus an inspectable chip in the mention
 * strip.
 *
 * We do NOT submit a real AI turn (no provider keys in e2e) — the picker,
 * search round-trip, and chip are the capability surface under proof.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("chat @-mentions — composer picker", () => {
  test("@ opens the type menu, scoped search inserts a mention chip", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "chat-mention",
    });

    await page.goto(`/${orgSlug}/default/chat`);
    await expect(page).not.toHaveURL(/\/login/);

    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.click();

    // Stage 1 — typing "@" opens the reference-type menu.
    await page.keyboard.type("@");
    const menu = page.getByTestId("mention-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("mention-type-repository")).toBeVisible();
    await expect(page.getByTestId("mention-type-node")).toBeVisible();

    // Keyboard: ArrowDown moves the active row.
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("mention-type-branch")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Typing filters the type list; "cap" narrows to Capabilities.
    await page.keyboard.type("cap");
    await expect(page.getByTestId("mention-type-capability")).toBeVisible();
    await expect(page.getByTestId("mention-type-repository")).toHaveCount(0);

    // Enter selects the type → stage 2 (scoped search) with its header.
    await page.keyboard.press("Enter");
    await expect(menu.getByText("Capabilities").first()).toBeVisible();

    // Search within capabilities — search_references itself is always
    // registered, so this needs no seeded workspace data.
    await page.keyboard.type("references");
    const firstResult = page.getByTestId("mention-result-0");
    await expect(firstResult).toBeVisible({ timeout: 10_000 });
    await expect(menu.getByText("search references").first()).toBeVisible();

    await page.screenshot({ path: "e2e/screenshots/chat-mentions-menu.png" });

    // Enter inserts the readable placeholder and closes the menu.
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(composer).toHaveValue(/@search references /);

    // The mention strip shows an inspectable chip for the reference.
    const strip = page.getByTestId("mention-strip");
    await expect(strip).toBeVisible();
    await expect(strip.getByTestId("mention-chip-capability")).toBeVisible();

    await page.screenshot({ path: "e2e/screenshots/chat-mentions-chip.png" });

    // Removing the chip detaches the reference but keeps the typed words.
    await strip.getByRole("button", { name: /remove mention/i }).click();
    await expect(page.getByTestId("mention-strip")).toHaveCount(0);
    await expect(composer).toHaveValue(/@search references /);
  });

  test("mouse flow selects a type and Escape dismisses the menu", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "chat-mention-mouse",
    });

    await page.goto(`/${orgSlug}/default/chat`);
    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.click();

    await page.keyboard.type("@");
    const menu = page.getByTestId("mention-menu");
    await expect(menu).toBeVisible();

    // Click a type row with the mouse — the menu must survive the mousedown
    // (focus stays in the textarea) and move to the scoped-search stage.
    await page.getByTestId("mention-type-capability").click();
    await expect(menu.getByText("Capabilities").first()).toBeVisible();

    // Escape dismisses without inserting anything.
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(composer).toHaveValue("@");
  });
});
