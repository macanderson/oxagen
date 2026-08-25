/**
 * fleet-lineage — e2e spec for the fleet-lineage explorer
 * (`/{orgSlug}/{workspaceSlug}/automations/lineage`, issue #1078).
 *
 * Signs up a fresh user (a brand-new workspace has zero fleet dispatches) and
 * asserts:
 *  - the page renders under the shared Automations tab strip (Automations ·
 *    Workflows · Lineage) with Lineage selected, via the real
 *    RSC → invoke → agent.subagent_fanout.list path (list_subagent_fanouts);
 *  - with no dispatches yet, the dispatch picker's empty state renders (never
 *    a blank page or a crash) alongside the always-available paste-a-
 *    dispatch-id form — the "no dead ends" requirement;
 *  - pasting an unknown dispatch id round-trips through `?dispatchId=`,
 *    query_lineage resolves not-found, and the page honestly falls back to
 *    the picker with a named not-found banner instead of erroring out.
 *
 * Does NOT dispatch a real subagent fan-out (would need a live agent run) —
 * the multi-level-tree render (canvas + violation flagging) is covered
 * without rendering by lib/lineage/canvas-map.test.ts and
 * lib/lineage/tree.test.ts, and the canvas/list component wiring by
 * lineage-explorer.test.tsx / lineage-node-tree.test.tsx (mocked reagraph).
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored).
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

test("lineage page renders under the tab strip; fresh workspace shows the dispatch picker with a paste-id form", async ({
  page,
}) => {
  const user = await signUpFreshUser(page, { orgPrefix: "e2e-lineage" });

  await page.goto(`/${user.orgSlug}/default/automations/lineage`);

  // Shared Automations tab strip — Lineage is the newest tab.
  await expect(page.getByRole("tab", { name: "Lineage" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("tab", { name: "Automations" })).toBeVisible();
  // automations-header.tsx renders three tabs — Automations · Workflows ·
  // Lineage. The "Triggers" tab this spec asserted is a tab it outlived.
  await expect(page.getByRole("tab", { name: "Workflows" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Lineage" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Fresh workspace → zero fan-outs → the picker's empty state, never a
  // blank page or a thrown error.
  await expect(page.getByText("No fleet dispatches yet")).toBeVisible({
    timeout: 20_000,
  });

  // The paste-a-dispatch-id form is always available, even with zero recent
  // dispatches — the "no dead ends" requirement.
  await expect(page.getByTestId("dispatch-id-input")).toBeVisible();
  await expect(page.getByTestId("dispatch-id-submit")).toBeVisible();

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "fleet-lineage-picker-empty.png"),
    fullPage: true,
  });
});

test("pasting an unknown dispatch id round-trips through query_lineage and falls back to the picker with a named not-found banner", async ({
  page,
}) => {
  const user = await signUpFreshUser(page, { orgPrefix: "e2e-lineage-nf" });

  await page.goto(`/${user.orgSlug}/default/automations/lineage`);
  await expect(page.getByTestId("dispatch-id-input")).toBeVisible({
    timeout: 20_000,
  });

  const bogusId = "sfo_does_not_exist_e2e";
  await page.getByTestId("dispatch-id-input").fill(bogusId);
  // Native GET <form> submit — a real navigation to ?dispatchId=<bogusId>.
  await page.getByTestId("dispatch-id-submit").click();

  await expect(page).toHaveURL(new RegExp(`dispatchId=${bogusId}`), {
    timeout: 20_000,
  });

  // query_lineage resolves FanoutNotFoundError → queryLineageAction returns
  // ok:false → the section honestly falls back to the picker, naming the id
  // that failed instead of a blank page or an unhandled crash.
  const banner = page.getByRole("alert").filter({ hasText: bogusId });
  await expect(banner).toBeVisible({ timeout: 20_000 });

  // Still not a dead end: the paste-id form is present again for a retry.
  await expect(page.getByTestId("dispatch-id-input")).toBeVisible();

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "fleet-lineage-not-found.png"),
    fullPage: true,
  });
});
