/**
 * ONE-OFF live verification (not committed to the CI suite).
 * No mocks: real chat agent (live LLM via gateway), real page_form_fill tool,
 * real FillOverlay accept → form state mutation.
 */
import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "screenshots-live");

test("LIVE: drawer agent fills the workspace settings form from a prompt", async ({ page }) => {
  test.setTimeout(180_000);
  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "live-fill" });

  await page.goto(`/${orgSlug}/default/settings/general`);
  // The workspace general form registers as fillable.
  await expect(page.locator("form").first()).toBeVisible({ timeout: 20_000 });

  // Open the Ask drawer via the topbar ask-bar ("ask" intent opens the drawer).
  const askInput = page.getByLabel("Ask, navigate, or search");
  await expect(askInput).toBeVisible({ timeout: 10_000 });

  // Capture the stream request body to prove pageContext rides along.
  let sawPageContext = false;
  page.on("request", (req) => {
    if (req.url().includes("/api/v1/chat/stream") && req.method() === "POST") {
      const body = req.postData() ?? "";
      if (body.includes("fillableForm") && body.includes("workspace")) sawPageContext = true;
    }
  });

  await askInput.fill(
    "please update this form: set the description to 'Primary production workspace for the data team' ",
  );
  await askInput.press("Enter");

  // Either the drawer opened for a conversational turn, or the one-shot fill
  // path ran. In both paths the FillOverlay is the surface that shows diffs.
  const overlay = page.getByRole("status", { name: /AI fill suggestions/i });
  await expect(overlay).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: path.join(SHOT_DIR, "fill-1-overlay.png"), fullPage: true });

  // Accept all proposals.
  await page.getByRole("button", { name: /apply all/i }).click();

  // The description field on the page should now contain the proposed text.
  const desc = page.locator('textarea[name="description"], input[name="description"]').first();
  await expect(desc).toHaveValue(/production workspace/i, { timeout: 10_000 });
  await page.screenshot({ path: path.join(SHOT_DIR, "fill-2-applied.png"), fullPage: true });

  console.log("[LIVE] pageContext on stream request:", sawPageContext);
});
