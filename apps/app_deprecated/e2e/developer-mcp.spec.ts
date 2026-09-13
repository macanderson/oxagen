/**
 * developer-mcp.spec.ts — e2e proof for the org Developer → MCP surface.
 *
 * Drives /{orgSlug}/developer/mcp for a fresh org (no API key yet):
 *   1. No-key fallback CTA renders and links to the Tokens tab; the install
 *      tabs still render (graceful fallback) with the $OXAGEN_API_KEY
 *      placeholder — see developer/mcp/page.tsx, which always builds the
 *      snippets, key or no key.
 *   2. After creating a key on the Tokens tab, returning to MCP swaps the
 *      warning for the "first active token" notice and rewrites the snippets
 *      with the masked key prefix instead of the placeholder.
 *
 * Proves: get_install_instructions (capability-ui-map).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";

test("developer MCP: no-key fallback, then live key injection after creating a token", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "e2e-mcp" });

  // ── 1. Fresh org has no API key — the no-key fallback CTA renders ──────────
  await gotoStable(page, `/${orgSlug}/developer/mcp`);
  await expect(page).not.toHaveURL(/\/login/);
  await expect(
    page.getByRole("heading", { name: "MCP server", level: 3 }),
  ).toBeVisible({ timeout: 15_000 });

  await expect(page.getByText("No active API token found.")).toBeVisible();
  const tokensLink = page.getByRole("link", { name: "Tokens" });
  await expect(tokensLink).toBeVisible();
  await expect(tokensLink).toHaveAttribute(
    "href",
    `/${orgSlug}/developer/tokens`,
  );

  // Install tabs still render (graceful fallback) using the placeholder key.
  await expect(page.getByRole("tab", { name: "Claude Code" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Claude Desktop" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Cursor" })).toBeVisible();
  await expect(page.locator("[data-mcp-code]").first()).toContainText(
    "$OXAGEN_API_KEY",
  );

  // ── 2. Create a key on the Tokens tab ───────────────────────────────────────
  await gotoStable(page, `/${orgSlug}/developer/tokens`);
  await page.getByRole("button", { name: "Create token" }).click();
  await page.getByLabel("Token name").fill("e2e mcp key");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByText("Copy your token now — it won't be shown again"),
  ).toBeVisible({ timeout: 10_000 });

  // ── 3. Back on MCP — the live-key notice replaces the warning, snippets are
  //      rewritten with the masked key instead of the placeholder. ───────────
  await gotoStable(page, `/${orgSlug}/developer/mcp`);
  await expect(
    page.getByText(
      "The snippets below use your org's first active API token (prefix shown).",
    ),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("No active API token found.")).toHaveCount(0);

  const codeBlock = page.locator("[data-mcp-code]").first();
  await expect(codeBlock).not.toContainText("$OXAGEN_API_KEY");
  await expect(codeBlock).toContainText("•");

  await expect(
    page.getByRole("button", { name: "Copy Claude Code install command" }),
  ).toBeVisible();

  // Switch tabs — the JSON snippet for Claude Desktop renders.
  await page.getByRole("tab", { name: "Claude Desktop" }).click();
  await expect(
    page.getByRole("tabpanel").filter({ hasText: "mcpServers" }),
  ).toBeVisible();
});
