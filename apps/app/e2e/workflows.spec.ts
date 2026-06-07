/**
 * workflows — e2e spec.
 *
 * Covers:
 *  1. Auth guard: /workflows requires auth.
 *  2. Workflows page renders with empty state for a fresh workspace.
 *  3. Workflows link appears in the sidebar nav under Tools.
 *  4. Navigating via the sidebar link lands on /workflows.
 *
 * Note: workflow execution (Inngest fan-out, progress polling) requires a live
 * Inngest server and is tested via unit tests for the pure logic. The E2E spec
 * covers routing, auth, sidebar integration, and empty-state rendering.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("workflows — auth guard", () => {
  test("redirects to login when unauthenticated", async ({ page }) => {
    await page.goto("/some-org/some-workspace/workflows");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("workflows page — empty state", () => {
  test("renders empty-state message when no workflows exist", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "wf-empty" });

    // Fresh signup lands at /{orgSlug}/default (or first workspace).
    // Navigate explicitly to the workflows page.
    const currentUrl = new URL(page.url());
    const pathParts = currentUrl.pathname.split("/").filter(Boolean);
    // pathParts[0] = orgSlug, pathParts[1] = workspaceSlug
    const workspaceSlug = pathParts[1] ?? "default";

    await page.goto(`/${orgSlug}/${workspaceSlug}/workflows`);
    await expect(page).not.toHaveURL(/\/login/);

    // Empty-state content must be visible.
    await expect(
      page.getByText(/No workflows yet/i),
    ).toBeVisible({ timeout: 10_000 });

    // The "ask the agent" hint must appear.
    await expect(
      page.getByText(/ask the agent/i),
    ).toBeVisible();
  });

  test("shows stats strip with zero counts", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "wf-stats" });

    const currentUrl = new URL(page.url());
    const pathParts = currentUrl.pathname.split("/").filter(Boolean);
    const workspaceSlug = pathParts[1] ?? "default";

    await page.goto(`/${orgSlug}/${workspaceSlug}/workflows`);
    await expect(page).not.toHaveURL(/\/login/);

    // Wait for the page to render.
    await expect(page.getByText(/No workflows yet/i)).toBeVisible({ timeout: 10_000 });

    // Stats labels should be present.
    await expect(page.getByText("Active")).toBeVisible();
    await expect(page.getByText("Completed")).toBeVisible();
    await expect(page.getByText("Failed")).toBeVisible();
  });
});

test.describe("workflows sidebar nav", () => {
  test("Workflows link appears in the sidebar", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "wf-nav" });

    const currentUrl = new URL(page.url());
    const pathParts = currentUrl.pathname.split("/").filter(Boolean);
    const workspaceSlug = pathParts[1] ?? "default";

    // Go to the ask page where the sidebar is rendered.
    await page.goto(`/${orgSlug}/${workspaceSlug}/ask`);
    await expect(page).not.toHaveURL(/\/login/);

    // Wait for the shell to mount.
    await page.waitForLoadState("domcontentloaded");

    // The Workflows nav link must be visible in the sidebar.
    const workflowsLink = page.getByRole("link", { name: /workflows/i });
    await expect(workflowsLink).toBeVisible({ timeout: 10_000 });
  });

  test("clicking Workflows link navigates to /workflows", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "wf-click" });

    const currentUrl = new URL(page.url());
    const pathParts = currentUrl.pathname.split("/").filter(Boolean);
    const workspaceSlug = pathParts[1] ?? "default";

    await page.goto(`/${orgSlug}/${workspaceSlug}/ask`);
    await expect(page).not.toHaveURL(/\/login/);

    await page.waitForLoadState("domcontentloaded");

    // Click the Workflows sidebar link.
    const workflowsLink = page.getByRole("link", { name: /workflows/i });
    await expect(workflowsLink).toBeVisible({ timeout: 10_000 });
    await workflowsLink.click();

    // Must navigate to the workflows page.
    await page.waitForURL(
      (url) => url.pathname.endsWith("/workflows"),
      { timeout: 15_000 },
    );

    await expect(page).not.toHaveURL(/\/login/);
    expect(new URL(page.url()).pathname).toMatch(/\/workflows$/);
  });
});
