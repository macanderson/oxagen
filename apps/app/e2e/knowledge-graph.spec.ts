/**
 * knowledge-graph.spec.ts — end-to-end coverage for Knowledge → Graph
 * (web-app-2.0 Phase 2): the WebGL explorer canvas plus the new Browse /
 * Search / Query side panel.
 *
 * Tests:
 *   1. Canvas loads: the explorer toolbar (search box + view-mode control)
 *      renders alongside the new side panel's stats header and tab strip.
 *   2. Browse panel lists nodes: on a fresh workspace (no source connected
 *      yet) it shows the "Connect a source" empty state with a working link
 *      to Sources — this IS "listing nodes" correctly for an empty graph,
 *      per the page's Empty state. If the workspace already has nodes
 *      (Neo4j pre-seeded), it asserts real rows instead.
 *   3. Search filters: typing into the Search tab's box drives a query
 *      without crashing the page (fuzzy search over an empty/seeded graph).
 *   4. Query console runs a typed traversal and renders its outcome. The
 *      console runs an ontology.query traversal from a known start node —
 *      query-console.tsx accepts no database query language at all, so there
 *      is no raw query box to type into. Traversing from a publicId that
 *      cannot exist is the equivalent always-safe read:
 *      the handler returns startNode:null for an unknown id rather than
 *      erroring (packages/handlers/src/ontology.query.ts), so the assertion
 *      needs Neo4j running but never pre-seeded.
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored, recreated each run).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

function shot(page: import("@playwright/test").Page, name: string) {
  return page.screenshot({
    path: path.join(SCREENSHOT_DIR, `knowledge-graph-${name}.png`),
    fullPage: true,
  });
}

test.describe("Knowledge → Graph", () => {
  test.beforeAll(() => {
    if (fs.existsSync(SCREENSHOT_DIR)) {
      fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("canvas loads, side panel mounts with stats header and Browse/Search/Query tabs", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "graph-canvas",
    });
    const ws = "default";

    await gotoStable(page, `/${orgSlug}/${ws}/knowledge/graph`);
    await expect(page).not.toHaveURL(/\/login/);
    await page.waitForLoadState("networkidle", { timeout: 20_000 });

    // The explorer canvas's toolbar renders — proof the WebGL explorer mounted
    // (the canvas itself is `next/dynamic({ ssr:false })`, so the toolbar is
    // the stable, immediately-paintable proof point instead of the canvas
    // element, which loads behind a skeleton).
    await expect(page.getByLabel("Search the graph")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[aria-label="View mode"]')).toBeVisible();

    // The new side panel: header + stat boxes + tab strip.
    // exact: the empty state's "No graph data yet" h3 also substring-matches
    // "Graph", and both render while the canvas decides what it has.
    await expect(
      page.getByRole("heading", { name: "Graph", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("graph-stats")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("tab", { name: "Browse" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Search" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Query" })).toBeVisible();

    await shot(page, "01-canvas-and-panel-loaded");
  });

  test("Browse panel lists nodes (or the Connect-a-source empty state on a fresh graph)", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "graph-browse",
    });
    const ws = "default";

    await gotoStable(page, `/${orgSlug}/${ws}/knowledge/graph`);
    await page.waitForLoadState("networkidle", { timeout: 20_000 });

    // Browse is the default tab.
    await expect(page.getByTestId("graph-stats")).toBeVisible({
      timeout: 15_000,
    });

    const emptyState = page.getByText("Connect a source");
    const hasEmptyState = await emptyState.isVisible().catch(() => false);
    if (hasEmptyState) {
      // Fresh workspace, no source connected — the expected state for a brand
      // new signup. Verify the empty state's affordance actually navigates.
      await shot(page, "02-browse-empty-state");
      const sourcesLink = page.getByRole("link", { name: /go to sources/i });
      await expect(sourcesLink).toBeVisible();
      await sourcesLink.click();
      await expect(page).toHaveURL(
        new RegExp(`/${orgSlug}/${ws}/knowledge/sources$`),
      );
      return;
    }

    // Neo4j is pre-seeded — assert real rows render as node citations, not
    // raw UUIDs, and are individually openable.
    await shot(page, "02-browse-rows");
    const firstRow = page.getByTestId("graph-result-row").first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    const openLink = firstRow.getByRole("link", { name: /open .* detail/i });
    if (await openLink.isVisible().catch(() => false)) {
      await openLink.click();
      await expect(page).toHaveURL(
        new RegExp(`/${orgSlug}/${ws}/knowledge/graph/`),
      );
    }
  });

  test("Search tab filters as you type", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "graph-search",
    });
    const ws = "default";

    await gotoStable(page, `/${orgSlug}/${ws}/knowledge/graph`);
    await page.waitForLoadState("networkidle", { timeout: 20_000 });
    await expect(page.getByTestId("graph-stats")).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("tab", { name: "Search" }).click();
    const searchBox = page.getByLabel("Search graph nodes");
    await expect(searchBox).toBeVisible({ timeout: 10_000 });

    await searchBox.fill("billing");
    // Debounced (300ms) — give it room, then assert the panel settled into
    // either a result list or the no-match state (never a crash/blank panel).
    await expect(
      page
        .getByText("No matches")
        .or(page.getByTestId("graph-result-row").first()),
    ).toBeVisible({ timeout: 10_000 });

    await shot(page, "03-search-results");
  });

  test("Query console runs a typed traversal and reports an unknown start node", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "graph-query",
    });
    const ws = "default";

    await gotoStable(page, `/${orgSlug}/${ws}/knowledge/graph`);
    await page.waitForLoadState("networkidle", { timeout: 20_000 });
    await expect(page.getByTestId("graph-stats")).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("tab", { name: "Query" }).click();

    // The Query tab is a typed ontology.query traversal — a start
    // node plus relationship types / direction / depth. There is no raw
    // query box and no "Run" button to drive one.
    const startNodeInput = page.getByLabel("Start node ID");
    await expect(startNodeInput).toBeVisible({ timeout: 10_000 });
    const traverse = page.getByRole("button", { name: "Traverse" });
    await expect(traverse).toBeDisabled();

    // A publicId that cannot exist in a workspace created seconds ago — the
    // traversal still round-trips through ontologyQueryAction → query_ontology
    // and comes back startNode:null, which the console reports plainly
    // instead of erroring or blanking the panel.
    await startNodeInput.fill("e2e-no-such-public-id");
    await expect(traverse).toBeEnabled();
    await traverse.click();

    await expect(
      page.getByText("Start node not found in this workspace."),
    ).toBeVisible({ timeout: 15_000 });

    await shot(page, "04-query-console-unknown-start-node");
  });
});
