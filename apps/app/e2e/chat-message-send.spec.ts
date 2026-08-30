/**
 * chat.message.send — e2e spec.
 *
 * Signs up a fresh user, lands on the workspace chat page, and asserts the
 * composer is present and interactive (real capability surface, not just the
 * auth redirect).
 *
 * We do NOT submit a real AI message (that would require valid provider keys
 * and would be slow). We assert the chat UI surface: the composer renders,
 * is enabled, accepts input, and the send button is present.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("chat.message.send — auth guard", () => {
  test("chat page redirects unauthenticated users to /login", async ({
    page,
  }) => {
    await page.goto("/acme/default/chat");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("chat.message.send — authenticated composer", () => {
  test("fresh user lands on chat page with an enabled composer", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "chat-send" });

    await page.goto(`/${orgSlug}/default/chat`);
    await expect(page).not.toHaveURL(/\/login/);

    // The chat composer textarea must be visible and enabled.
    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await expect(composer).toBeEnabled();

    // Type into the composer to verify it accepts input.
    await composer.fill("Hello, Oxagen!");
    await expect(composer).toHaveValue("Hello, Oxagen!");

    // The send button must be present.
    const sendBtn = page.getByRole("button", { name: /^send message$/i });
    await expect(sendBtn).toBeVisible();
  });
});
