/**
 * billing-governed-actions.spec.ts — e2e for the ADR-052 governed-action meter.
 *
 * Drives /{orgSlug}/billing/governed-actions, which is the app surface for four
 * capabilities: `get_rate_card`, `get_action_usage`, `preview_action_cost` and
 * `get_evidence_retention`. This is the runtime proof behind their bindings in
 * `apps/app/capability-ui-map.json` — it asserts the page renders without an
 * error page, that each of the four capabilities' data actually reaches the
 * screen, and that the honesty rules survive the round trip.
 *
 * A fresh org has no governed-action activity, so the usage panel renders its
 * empty/zero state; that is the state most customers see first and the one most
 * likely to be rendered dishonestly. The arithmetic behind each figure is
 * covered by the contract/handler unit tests — here we prove the page is wired
 * and truthful.
 */

import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Per-spec subdirectory, not the shared screenshots root — beforeAll wipes it,
// and several specs pointed at one root delete each other's artifacts.
const SCREENSHOT_DIR = resolve(
  __dirname,
  "screenshots",
  "billing-governed-actions",
);

test.beforeAll(() => {
  rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test("governed actions: renders usage, rate card, calculator and retention for a fresh org", async ({
  page,
}) => {
  test.setTimeout(90_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "gov-actions" });

  await page.goto(`/${orgSlug}/billing/governed-actions`);
  await expect(page).not.toHaveURL(/\/login/);
  await page.waitForLoadState("domcontentloaded");

  // The billing shell reached this tab — not a 404, not the error boundary.
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Couldn't load governed actions")).toHaveCount(0);

  // ── get_action_usage ────────────────────────────────────────────────────
  await expect(
    page.getByRole("heading", { name: "This entitlement year" }),
  ).toBeVisible();
  await expect(page.getByText("Actions used", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Included in plan", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Charged as overage", { exact: true }),
  ).toBeVisible();
  // The zero model-token charge is a rendered row, never an omission.
  await expect(page.getByTestId("model-tokens-zero-row")).toBeVisible();
  await expect(page.getByTestId("model-tokens-zero-row")).toContainText(
    /Zero, deliberately/i,
  );
  // A fresh org has no activity: the empty state must teach, not show a bill.
  await expect(page.getByTestId("usage-empty-state")).toBeVisible();

  // ── get_rate_card ───────────────────────────────────────────────────────
  await expect(page.getByRole("heading", { name: "Rate card" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Volume bands" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Included per tier" }),
  ).toBeVisible();
  // Enterprise is negotiated per contract — never "unlimited", never blank.
  const enterpriseRow = page.getByTestId("rate-card-tier-enterprise");
  await expect(enterpriseRow).toContainText("Negotiated per contract");
  await expect(enterpriseRow).not.toContainText(/unlimited/i);
  // The zero token rate is published with its explanation.
  await expect(page.getByTestId("rate-card-model-tokens")).toContainText(
    "$0.00 per token",
  );

  // ── get_evidence_retention ──────────────────────────────────────────────
  await expect(
    page.getByRole("heading", { name: "Evidence retention" }),
  ).toBeVisible();
  // Opt-in is the promise: the off state says nothing is accruing.
  await expect(page.getByTestId("retention-opt-in-off")).toContainText(
    /Nothing is accruing/i,
  );
  // Unmeasured volume reads as unmeasured, never as 0 GB.
  await expect(page.getByText("Not measured yet").first()).toBeVisible();

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/governed-actions-usage.png`,
    fullPage: true,
  });

  // The app shell owns its own scroll container, so `fullPage` captures the
  // viewport rather than the whole document. Scroll each panel into view and
  // shoot it, so the committed proof covers all three read capabilities and not
  // just whichever one happened to be above the fold.
  await page.getByTestId("rate-card-tier-enterprise").scrollIntoViewIfNeeded();
  await expect(enterpriseRow).toBeInViewport();
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/governed-actions-rate-card.png`,
  });

  await page.getByTestId("retention-opt-in-off").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("retention-opt-in-off")).toBeInViewport();
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/governed-actions-retention.png`,
  });
});

test("governed actions: the calculator quotes a price and shows the ratio it used", async ({
  page,
}) => {
  test.setTimeout(90_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "gov-calc" });

  await page.goto(`/${orgSlug}/billing/governed-actions`);
  await page.waitForLoadState("domcontentloaded");

  const form = page.getByRole("form", {
    name: /governed action cost estimate/i,
  });
  await expect(form).toBeVisible({ timeout: 20_000 });

  // Idle state first — nothing is quoted until the customer asks.
  await expect(page.getByText(/No estimate yet/i)).toBeVisible();

  // These are React-controlled fields. Playwright's fill() clears the input and
  // drives a real keyboard-equivalent event sequence, so React's onChange sees
  // the new value — it is the right tool here. Note for other automation: a
  // browser-MCP `fill`-style tool APPENDS to the existing value instead, and a
  // raw `el.value = x` assignment is swallowed by React's value tracker. From
  // those, set the value through the native prototype setter and then dispatch
  // `new Event("input", { bubbles: true })`.
  const runs = page.getByLabel("Runs per year");
  await runs.fill("250000");
  await expect(runs).toHaveValue("250000");

  await page.getByLabel("Run class").selectOption("multi_step");
  await page.getByTestId("calc-submit").click();

  const result = page.getByTestId("calc-result");
  await expect(result).toBeVisible({ timeout: 20_000 });

  // The assumptions are rendered with the quote — a hidden ratio is a price a
  // buyer cannot check, which is the whole reason this capability exists.
  const assumptions = page.getByTestId("calc-assumptions");
  await expect(assumptions).toContainText("250,000 runs");
  await expect(assumptions).toContainText(/actions per run/i);
  await expect(assumptions).toContainText(
    /the published ratio for this run class/i,
  );
  await expect(assumptions).toContainText(/Multi-step/i);
  await expect(result).toContainText("Estimated overage");

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/governed-actions-calculator.png`,
    fullPage: true,
  });

  // A measured ratio must be reported as the customer's own, not as published.
  await page.getByLabel("Actions per run (optional)").fill("42");
  await page.getByTestId("calc-submit").click();
  await expect(assumptions).toContainText(/your measured ratio/i, {
    timeout: 20_000,
  });
  await expect(assumptions).toContainText("42 actions per run");

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/governed-actions-calculator-measured.png`,
    fullPage: true,
  });
});
