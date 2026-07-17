/**
 * agent-tools-hub.spec.ts
 *
 * E2E for the consolidated Agent Tools IA:
 *   1. Workbench → Agent Tools hub — the single home for everything an agent can
 *      be equipped with: All Tools / Skills / MCP Servers / Capabilities tabs.
 *   2. Marketplace is two-sided — Agent Tools + Integrations — and the root
 *      redirects to the Agent Tools side.
 *   3. Legacy URLs (workbench/skills, marketplace/{browse,installed,mcp},
 *      settings/{plugins,skills}) redirect to their new homes.
 *   4. The Agent Builder's Equip step exposes the inline
 *      "Install more from Marketplace" flow (choke-point-gated installs).
 *   5. Mobile (390px): sidebar bottom bar carries the Workbench destinations and
 *      the builder's step nav is a thumb-reachable sticky bar.
 *
 * NOTE: needs the full local stack (`pnpm dev`: Postgres :5433 + app server),
 * same as the other signup-driven specs.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

const SCREENSHOTS_DIR = path.resolve(
  import.meta.dirname,
  "screenshots",
  "agent-tools-hub",
);

test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("Agent Tools consolidated IA", () => {
  test("hub tabs, two-sided marketplace, legacy redirects", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "agent-tools",
    });
    const ws = `/${orgSlug}/default`;

    // ── 1. Agent Tools hub ───────────────────────────────────────────────────
    await gotoStable(page, `${ws}/workbench/tools`);
    await expect(page).not.toHaveURL(/\/login/);

    // Sub-tabs of the hub.
    for (const label of [
      "All Tools",
      "Skills",
      "MCP Servers",
      "Capabilities",
    ]) {
      await expect(
        page
          .getByRole("tab", { name: label })
          .or(page.getByRole("link", { name: label }))
          .first(),
      ).toBeVisible({ timeout: 15_000 });
    }
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-agent-tools-hub-all-tools.png"),
      fullPage: true,
    });

    // Skills tab renders the skills panel (creation lives here now).
    await gotoStable(page, `${ws}/workbench/tools/skills`);
    await expect(page.getByTestId("new-skill-btn")).toBeVisible({
      timeout: 20_000,
    });
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-agent-tools-skills.png"),
      fullPage: true,
    });

    // MCP Servers tab renders installed list + install surfaces + snippets.
    await gotoStable(page, `${ws}/workbench/tools/mcp`);
    await expect(page.getByText("Installed MCP servers")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Install from the marketplace")).toBeVisible();
    await expect(page.getByText("Connect manually")).toBeVisible();
    // Registry administration must NOT render here — it lives in Settings.
    await expect(page.getByTestId("add-registry-btn")).toHaveCount(0);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-agent-tools-mcp.png"),
      fullPage: true,
    });

    // Capabilities tab renders the installed-plugins panel.
    await gotoStable(page, `${ws}/workbench/tools/capabilities`);
    await expect(page.getByText(/installed plugins/i).first()).toBeVisible({
      timeout: 20_000,
    });
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-agent-tools-capabilities.png"),
      fullPage: true,
    });

    // ── 2. Marketplace: two sides ───────────────────────────────────────────
    await gotoStable(page, `${ws}/marketplace`);
    await expect(page).toHaveURL(/\/marketplace\/agent-tools$/, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("marketplace-browse-tab-bar")).toBeVisible({
      timeout: 20_000,
    });
    // Agent-tool type chips only — no knowledge-source tab anywhere.
    await expect(
      page.getByTestId("marketplace-browse-tab-agent_skill"),
    ).toBeVisible();
    await expect(
      page.getByTestId("marketplace-browse-tab-mcp_server"),
    ).toBeVisible();
    await expect(
      page.getByTestId("marketplace-browse-tab-agent_capability"),
    ).toBeVisible();
    await expect(
      page.getByTestId("marketplace-browse-tab-knowledge_source"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("marketplace-browse-tab-integration"),
    ).toHaveCount(0);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "05-marketplace-agent-tools.png"),
      fullPage: true,
    });

    // Integrations side lists real connectors from the ingestion registry.
    await gotoStable(page, `${ws}/marketplace/integrations`);
    await expect(page.getByTestId("integrations-grid")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("integration-connect-github")).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "06-marketplace-integrations.png"),
      fullPage: true,
    });

    // The page must never say "knowledge source".
    await expect(page.getByText(/knowledge source/i)).toHaveCount(0);

    // ── 3. Legacy redirects ─────────────────────────────────────────────────
    const redirects: Array<[string, RegExp]> = [
      [`${ws}/workbench/skills`, /\/workbench\/tools\/skills$/],
      [`${ws}/marketplace/browse`, /\/marketplace\/agent-tools$/],
      [`${ws}/marketplace/installed`, /\/workbench\/tools\/capabilities$/],
      [`${ws}/marketplace/mcp`, /\/workbench\/tools\/mcp$/],
      [`${ws}/settings/plugins`, /\/workbench\/tools\/capabilities$/],
      [`${ws}/settings/skills`, /\/workbench\/tools\/skills$/],
      // The whole Studio section renamed to Workbench — old URLs 301 across.
      [`${ws}/studio`, /\/workbench\/agents$/],
      [`${ws}/studio/tools/mcp`, /\/workbench\/tools\/mcp$/],
      [`${ws}/settings/environments`, /\/workbench\/environments$/],
    ];
    for (const [from, to] of redirects) {
      await page.goto(from);
      await expect(page).toHaveURL(to, { timeout: 20_000 });
    }
  });

  test("builder Equip step installs inline from the marketplace modal", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "equip-inline",
    });
    const ws = `/${orgSlug}/default`;

    await gotoStable(page, `${ws}/workbench/agents/new`);
    await expect(page).not.toHaveURL(/\/login/);

    // Jump straight to the Equip step via the step rail.
    const equipStep = page.getByTestId("builder-step-equip");
    await expect(equipStep).toBeVisible({ timeout: 30_000 });
    await equipStep.click();

    const browseBtn = page.getByTestId("equip-browse-marketplace");
    await expect(browseBtn).toBeVisible({ timeout: 15_000 });
    await browseBtn.click();

    // The Agent Tools Marketplace modal opens with the three-tab taxonomy.
    await expect(page.getByText("Agent Tools Marketplace")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("marketplace-tab-agent_skill")).toBeVisible();
    await expect(page.getByTestId("marketplace-tab-mcp_server")).toBeVisible();
    await expect(
      page.getByTestId("marketplace-tab-agent_capability"),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "07-equip-inline-marketplace.png"),
      fullPage: true,
    });
  });

  test("mobile: bottom bar + thumb-reachable builder step nav @ 390px", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });

    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "mobile-tools",
    });
    const ws = `/${orgSlug}/default`;

    // Mobile bottom bar shows the primary destinations (Ask/Overview/
    // Knowledge/Automations). After the web-app-2.0 nav re-group, Agents is no
    // longer a top-level bar tab — it moved into the "More" overflow sheet,
    // still one tap away.
    await gotoStable(page, `${ws}/workbench/agents`);
    const nav = page.getByRole("navigation", { name: /mobile navigation/i });
    await expect(nav).toBeVisible({ timeout: 20_000 });
    // A primary destination renders directly in the bar.
    await expect(nav.getByRole("link", { name: "Sessions" })).toBeVisible();
    // Agents is reachable via the "More" sheet.
    await nav.getByRole("button", { name: /more navigation/i }).click();
    const moreNav = page.getByRole("navigation", {
      name: /more destinations/i,
    });
    await expect(moreNav.getByRole("link", { name: "Agents" })).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "08-mobile-bottom-bar.png"),
      fullPage: false,
    });

    // Builder: sticky step nav with large touch targets and a step counter.
    await gotoStable(page, `${ws}/workbench/agents/new`);
    const next = page.getByTestId("builder-next");
    await expect(next).toBeVisible({ timeout: 30_000 });
    const box = await next.boundingBox();
    expect(box).not.toBeNull();
    // Thumb-sized target (≥44px high) per mobile a11y guidance.
    expect(box!.height).toBeGreaterThanOrEqual(44);
    // Step counter visible on mobile.
    await expect(page.getByText(/^1 \/ \d+$/)).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "09-mobile-builder-thumb-nav.png"),
      fullPage: false,
    });
  });
});
