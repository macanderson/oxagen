/**
 * security-audit-filter-export.spec.ts — e2e for the audit-record link of the
 * accountability chain: /{orgSlug}/security/audit.
 *
 * The audit page is pre-existing and COMPLETE (filterable, keyset-paginated,
 * signed export gated Enterprise + security-manager) — this spec drives it
 * end-to-end for a fresh Enterprise org so the surface has real e2e proof:
 *
 *   1. Page renders with the filter bar (free-text, outcome, date range).
 *   2. Typing a free-text filter and submitting updates the URL (?q=) and the
 *      view re-renders without erroring — the filter round-trips through
 *      query_audit_log.
 *   3. On an Enterprise org with an owner viewer, export is unlocked (not the
 *      disabled/upsell state) and the NDJSON export link resolves to a
 *      successful, correctly-typed response — proving the export route (not
 *      just the disabled button) actually works.
 *
 * Enterprise tier is required to reach export at all — seeded via
 * seedSubscription() standing in for the Stripe webhook (billing-credits
 * pattern). A brand-new org already has audit history (org/workspace
 * creation write security_events), so this is not a first-run empty state.
 */

import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { signUpFreshUser } from "./helpers/signup";
import { seedSubscription } from "./helpers/seed-subscription";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Per-spec subdirectory, NOT the shared `e2e/screenshots` root: the beforeAll
// below wipes this directory, and pointing several specs at the same root made
// each one delete the artifacts the previously-run specs had just captured.
const SCREENSHOT_DIR = resolve(
  __dirname,
  "screenshots",
  "security-audit-filter-export",
);

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))
    return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5433/oxagen",
);

async function getOrgId(orgSlug: string): Promise<string> {
  const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
  try {
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM org.organizations WHERE slug = ${orgSlug}
    `;
    if (!row)
      throw new Error(`security-audit e2e: org not found for slug ${orgSlug}`);
    return row.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test.beforeAll(() => {
  rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test("audit log: filter bar round-trips through the URL and Enterprise export succeeds", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "audit-log" });
  const orgId = await getOrgId(orgSlug);
  // Audit export additionally requires Enterprise (org creator is Owner by default).
  await seedSubscription({
    orgId,
    planSlug: "enterprise-v2",
    planName: "Enterprise",
  });

  await page.goto(`/${orgSlug}/security/audit`);
  await expect(page).not.toHaveURL(/\/login/);
  await page.waitForLoadState("domcontentloaded");

  // Filter bar renders with its four controls.
  const search = page.getByLabel("Free-text audit filter");
  await expect(search).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Outcome filter")).toBeVisible();
  await expect(page.getByLabel("From date")).toBeVisible();
  await expect(page.getByLabel("To date")).toBeVisible();

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/audit-log-default.png`,
    fullPage: true,
  });

  // Submitting a free-text filter round-trips to the URL and re-renders.
  await search.fill("organization");
  await search.press("Enter");
  await expect(page).toHaveURL(/[?&]q=organization/);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByLabel("Free-text audit filter")).toHaveValue(
    "organization",
  );

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/audit-log-filtered.png`,
    fullPage: true,
  });

  // Enterprise + owner unlocks export — the buttons are real links, not the
  // disabled/Lock upsell state.
  const exportNdjson = page.getByRole("link", { name: /Export NDJSON/i });
  await expect(exportNdjson).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Export NDJSON/i }),
  ).toHaveCount(0);

  const href = await exportNdjson.getAttribute("href");
  expect(href).toBeTruthy();
  expect(href).toContain("/export");
  expect(href).toContain("format=ndjson");

  // Prove the export route itself works (not just that the button is enabled):
  // fetch it through the authenticated page context and check the response.
  const exportUrl = new URL(href!, page.url()).toString();
  const response = await page.request.get(exportUrl);
  expect(response.status()).toBe(200);
  const contentType = response.headers()["content-type"] ?? "";
  expect(contentType).toMatch(/ndjson|json|octet-stream|text/i);
});

test("audit log: non-Enterprise org shows the upsell and export stays locked", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, {
    orgPrefix: "audit-log-free",
  });

  await page.goto(`/${orgSlug}/security/audit`);
  await expect(page).not.toHaveURL(/\/login/);
  await page.waitForLoadState("domcontentloaded");

  // Free-tier: export is a disabled, locked control — never a silent 200.
  const lockedExport = page.getByRole("button", { name: /Export NDJSON/i });
  await expect(lockedExport).toBeVisible({ timeout: 15_000 });
  await expect(lockedExport).toBeDisabled();
});
