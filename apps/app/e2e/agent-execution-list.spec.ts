/**
 * agent-execution-list — e2e spec for the Activity list (empty state).
 *
 * Signs up a fresh user (a brand-new workspace has zero runs) and asserts the
 * Activity page renders through the real RSC → invoke → agent.execution.list →
 * Postgres path and shows the empty state. The POPULATED list + span-tree path
 * is covered by agent-trace-get.spec.ts (which seeds a run).
 *
 * Screenshot goes to apps/app/e2e/screenshots/ (gitignored).
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

test("activity list renders the empty state for a fresh workspace", async ({
  page,
}) => {
  const user = await signUpFreshUser(page, { orgPrefix: "e2e-actlist" });

  await page.goto(`/${user.orgSlug}/default/activity`);
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/no agent runs yet/i)).toBeVisible({
    timeout: 20_000,
  });

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "activity-empty.png"),
    fullPage: true,
  });
});
