/**
 * access-review.spec.ts — e2e for the identity link's periodic review surface:
 * /{orgSlug}/access (Sessions · Reviews), the SOC 2 CC6 evidence pages.
 *
 * Access is pre-existing and COMPLETE, gated to Enterprise plans. This spec
 * drives it end-to-end for a fresh Enterprise org (the creator is the sole
 * member and org Owner):
 *
 *   1. A non-Enterprise org is redirected away from /access (the layout gate).
 *   2. On an Enterprise org, Sessions renders the caller's own active session,
 *      badged "Your session" (self-revoke is disabled — CC6.1 evidence).
 *   3. Reviews renders the caller's own member row with the Owner role badge
 *      and a "You" badge, Confirm disabled for self (CC6.3 evidence) — the
 *      write path itself (confirmMemberAccessAction / revokeMemberAccessAction)
 *      is covered by actions.test.ts; this proves the page renders and gates
 *      correctly end-to-end.
 */

import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { signUpFreshUser } from "./helpers/signup";
import { seedSubscription } from "./helpers/seed-subscription";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = resolve(__dirname, "screenshots");

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
      throw new Error(`access-review e2e: org not found for slug ${orgSlug}`);
    return row.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test.beforeAll(() => {
  rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test("access: non-Enterprise org is redirected away from the gated section", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "access-free" });

  await page.goto(`/${orgSlug}/access`);
  await page.waitForLoadState("domcontentloaded");
  // Assert we left the Access SECTION, scoped to this org's path. A bare
  // /\/access/ regex would false-match the org slug itself ("access-free-…"),
  // so it can never pass however the gate behaves — scope it to /{org}/access.
  await expect(page).not.toHaveURL(new RegExp(`/${orgSlug}/access`));
});

test("access: Enterprise org renders own session + own review row with self-action gates", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, {
    orgPrefix: "access-review",
  });
  const orgId = await getOrgId(orgSlug);
  await seedSubscription({
    orgId,
    planSlug: "enterprise-v2",
    planName: "Enterprise",
  });

  // Sessions tab.
  await page.goto(`/${orgSlug}/access/sessions`);
  await expect(page).toHaveURL(/\/access\/sessions/);
  await page.waitForLoadState("domcontentloaded");

  await expect(
    page.getByText("Active sessions", { exact: false }).first(),
  ).toBeVisible({
    timeout: 15_000,
  });
  // The caller's own session is present and explicitly not revokable.
  await expect(page.getByText("Your session", { exact: true })).toBeVisible();

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/access-sessions.png`,
    fullPage: true,
  });

  // Reviews tab. PageTabs renders each tab as <Link role="tab">, so it must be
  // located by the "tab" role — getByRole("link") no longer matches (the
  // element's ARIA role is overridden to "tab"), which timed out the click.
  await page.getByRole("tab", { name: "Reviews" }).click();
  await expect(page).toHaveURL(/\/access\/reviews/);
  await page.waitForLoadState("domcontentloaded");

  await expect(
    page.getByText("Access review", { exact: false }).first(),
  ).toBeVisible({
    timeout: 15_000,
  });
  // The org creator's own row: Owner role badge + "You" self badge. The badge
  // renders the raw org-role value ({m.role}, e.g. "owner") with a `capitalize`
  // CSS class — Playwright matches the DOM text, not the CSS-transformed
  // rendering, so match the role case-insensitively rather than exact "Owner".
  await expect(page.getByText(/^owner$/i).first()).toBeVisible();
  await expect(page.getByText("You", { exact: true })).toBeVisible();

  // Confirm is present but disabled for the self row (isSelf gate) — the
  // real write path is exercised in actions.test.ts against a different actor.
  const confirmSelf = page.getByRole("button", { name: /Confirm/i });
  await expect(confirmSelf).toBeVisible();
  await expect(confirmSelf).toBeDisabled();

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/access-reviews.png`,
    fullPage: true,
  });
});
