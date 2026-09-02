/**
 * ONE-OFF live verification (not committed to the CI suite).
 * No mocks: real chat agent (live LLM via gateway) on the wand panel, real
 * page_form_fill tool call, real FillOverlay accept -> form state mutation.
 */
import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots-live",
);

test("LIVE: wand agent fills the workspace settings form from a prompt", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "live-fill" });

  await page.goto(`/${orgSlug}/default/settings/general`);
  await expect(page.locator("#ws-description")).toBeVisible({
    timeout: 30_000,
  });

  // Prove pageContext rides the stream request.
  let sawPageContext = false;
  page.on("request", (req) => {
    if (req.url().includes("/api/v1/chat/stream") && req.method() === "POST") {
      const body = req.postData() ?? "";
      if (body.includes('"fillableForm"') && body.includes("workspace-general"))
        sawPageContext = true;
    }
  });

  // Open the wand panel (conversational agent) and ask for a fill.
  await page.getByRole("button", { name: "Open AI agent" }).click();
  const composer = page.getByPlaceholder(/send a message/i);
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill(
    "Update this form: set the description to exactly 'Primary production workspace for the data team'",
  );
  await page.getByRole("button", { name: /send message/i }).click();

  // Real LLM turn -> page_form_fill -> FillOverlay.
  const overlay = page.getByRole("status", { name: "AI fill suggestions" });
  await expect(overlay).toBeVisible({ timeout: 120_000 });
  await page.screenshot({
    path: path.join(SHOT_DIR, "fill-1-overlay.png"),
    fullPage: true,
  });

  // Close the wand so its backdrop doesn't cover the overlay, then accept.
  await page
    .locator("#wand-panel")
    .getByRole("button", { name: "Close" })
    .click();
  await expect(page.getByPlaceholder(/send a message/i)).toBeHidden({
    timeout: 10_000,
  });
  await page
    .getByRole("button", { name: "Accept suggestion for description" })
    .click();

  await expect(page.locator("#ws-description")).toHaveValue(
    /production workspace/i,
    { timeout: 10_000 },
  );
  await page.screenshot({
    path: path.join(SHOT_DIR, "fill-2-applied.png"),
    fullPage: true,
  });
  console.log("[LIVE] pageContext on stream request:", sawPageContext);
  expect(sawPageContext).toBe(true);
});
