/**
 * parent-route-redirects — every parent "default tab" route resolves to its
 * first sub-page instead of 500-ing.
 *
 * Regression guard for the Next 16 Cache Components (PPR) bug where a Server
 * Component that awaited `params` and then called redirect() degraded the
 * redirect into a client-rendered `<meta http-equiv="refresh">` fallback. Inside
 * the app-shell layout tree that forced client re-render threw and surfaced
 * global-error ("Something went wrong"), so org root, Workbench, Settings,
 * Knowledge, Marketplace, Access, Billing and Developer roots all 500'd. The
 * redirect pages now read their slugs from the `x-url` header (requestScopeSlugs)
 * so the redirect stays a clean HTTP 307. Workspace root is the Overview page
 * (content, not a redirect) and is asserted to render.
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored).
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";

const screenshotDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

async function expectHealthyPage(page: Page): Promise<void> {
  // global-error boundary text — the exact symptom this fix removes.
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  // not-found.tsx — a bare parent must resolve, never 404.
  await expect(page.getByText(/^404$/)).toHaveCount(0);
}

test("parent routes resolve to their default sub-page without erroring", async ({
  page,
}) => {
  const { orgSlug } = await signUpFreshUser(page);
  const ws = "default";

  // Each bare parent → the sub-page it must land on.
  const redirects: { from: string; to: RegExp }[] = [
    // Org root → the org dashboard, the usage/metering home (#1053 moved it
    // there from the first workspace; apps/app/src/app/[orgSlug]/page.tsx
    // redirects unconditionally so an org with zero workspaces still lands
    // somewhere real). What the dashboard renders is org-dashboard.spec.ts.
    { from: `/${orgSlug}`, to: new RegExp(`/${orgSlug}/dashboard$`) },
    // Workspace-scope section parents → first tab.
    {
      from: `/${orgSlug}/${ws}/workbench`,
      to: new RegExp(`/${orgSlug}/${ws}/workbench/agents$`),
    },
    {
      from: `/${orgSlug}/${ws}/settings`,
      to: new RegExp(`/${orgSlug}/${ws}/settings/general$`),
    },
    {
      from: `/${orgSlug}/${ws}/knowledge`,
      to: new RegExp(`/${orgSlug}/${ws}/knowledge/sources$`),
    },
    {
      from: `/${orgSlug}/${ws}/marketplace`,
      to: new RegExp(`/${orgSlug}/${ws}/marketplace/agent-tools$`),
    },
    // Org-scope section parents → first tab.
    // Access is enterprise-only: its layout redirects non-enterprise orgs to
    // the org root (apps/app/src/app/[orgSlug]/access/layout.tsx), which now
    // forwards to the dashboard. A fresh signup is not enterprise, so the
    // healthy landing for bare /access is the org dashboard — the point
    // stands: it must resolve cleanly, never 500.
    {
      from: `/${orgSlug}/access`,
      to: new RegExp(`/${orgSlug}/dashboard$`),
    },
    {
      from: `/${orgSlug}/billing`,
      to: new RegExp(`/${orgSlug}/billing/subscription$`),
    },
    {
      from: `/${orgSlug}/developer`,
      to: new RegExp(`/${orgSlug}/developer/mcp$`),
    },
  ];

  for (const { from, to } of redirects) {
    await gotoStable(page, from);
    // Poll the URL only (toHaveURL) — NOT waitForURL, which also waits for the
    // "load" lifecycle event. PPR-streamed pages (the Overview page especially)
    // can keep "load" pending or re-fire it on RSC prefetch, so the redirect
    // lands correctly but "load" never settles and waitForURL times out even
    // though page.url() already matches.
    await expect(page, `bare parent ${from} should resolve to ${to}`).toHaveURL(
      to,
      { timeout: 20_000 },
    );
    await expectHealthyPage(page);
  }

  // Workspace root is the Overview page — content, not a redirect. It must
  // render (this is the "workspaces overview page" a workspace lands on).
  await gotoStable(page, `/${orgSlug}/${ws}`);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible({
    timeout: 20_000,
  });
  await expectHealthyPage(page);

  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({
    path: path.join(screenshotDir, "parent-route-redirects-overview.png"),
    fullPage: true,
  });
});
