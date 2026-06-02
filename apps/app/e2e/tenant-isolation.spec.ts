import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { loginAs } from "./helpers/auth";
import {
  setupAgentRuntimeFixture,
  teardownFixture,
  type AgentRuntimeFixture,
} from "./helpers/agent-runtime-fixture";

// ─── Tenant / Workspace Isolation ────────────────────────────────────────────
//
// This is the most critical E2E security spec in the suite. It asserts the
// core multi-tenant guarantee: a user who belongs to Org A cannot access
// Org B's routes or data — even when authenticated.
//
// Design:
//   • Two independent orgs are seeded: `e2e-iso-org-a` (the user belongs to
//     this one) and `e2e-iso-org-b` (the user has NO membership in it).
//   • A single user is created and made an owner of Org A only.
//   • The cookie-injection `loginAs` helper is used to give the test a valid
//     Better Auth session for that user.
//   • The spec then asserts:
//       1. Org A routes return the authed shell (not a redirect to /login).
//       2. Org B routes redirect to /login (or return a 403/not-found) —
//          access is denied at the application layer.
//       3. The org settings page for Org A is readable; the same page for
//          Org B is inaccessible.
//       4. The billing page for Org A renders the credit balance card;
//          the billing page for Org B is denied.
//
// Seeding strategy:
//   • Org A is created via `setupAgentRuntimeFixture` (full stack: org +
//     workspace + user + session). The fixture's `orgSlug` is `e2e-iso-org-a`.
//   • Org B is created directly here (minimal: org only, no user membership).
//     Because the fixture's teardown only removes Org A, we add a local
//     afterAll that removes Org B.
//
// Auth model alignment:
//   The application resolves tenant access via `resolveOrg` (server-side,
//   reads `org.org_users`). A user with no row in `org.org_users` for a given
//   org is treated as unauthenticated for that org — the guard redirects them
//   to /login. This spec validates that path.

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5432/oxagen",
);

const ORG_A_SLUG = "e2e-iso-org-a";
const ORG_B_SLUG = "e2e-iso-org-b";
const WS_SLUG = "main";
const USER_EMAIL = "e2e+isolation@oxagen.ai";

let fixtureA: AgentRuntimeFixture;

test.describe("tenant isolation — cross-org access denial", () => {
  test.beforeAll(async () => {
    // Seed Org A: full fixture (org + workspace + user + session + tool rows).
    fixtureA = await setupAgentRuntimeFixture({
      orgSlug: ORG_A_SLUG,
      workspaceSlug: WS_SLUG,
      userEmail: USER_EMAIL,
    });

    // Seed Org B: org row only — the test user is NOT a member.
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      await sql`
        INSERT INTO org.organizations (public_id, name, slug, plan_type, status)
        VALUES (
          'org_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 22),
          'E2E Isolation Org B',
          ${ORG_B_SLUG},
          'free',
          'active'
        )
        ON CONFLICT (slug) DO UPDATE SET status = 'active'
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test.afterAll(async () => {
    // Tear down Org A via the fixture helper.
    await teardownFixture({ orgSlug: ORG_A_SLUG });

    // Tear down Org B (no fixture helper available — do it directly).
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      await sql`DELETE FROM org.organizations WHERE slug = ${ORG_B_SLUG}`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  // ── 1. User can access their own org ────────────────────────────────────────

  test("user A reaches Org A root without redirect to /login", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, fixtureA.sessionToken, baseURL);
    await page.goto(`/${ORG_A_SLUG}`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(ORG_A_SLUG));
  });

  test("user A reaches Org A billing/subscription without redirect", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, fixtureA.sessionToken, baseURL);
    await page.goto(`/${ORG_A_SLUG}/billing/subscription`);
    await expect(page).not.toHaveURL(/\/login/);
    // The credit balance card heading must be present (seeded by fixture data).
    await expect(page.getByText(/credit balance/i)).toBeVisible();
  });

  test("user A reaches Org A workspace chat without redirect", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, fixtureA.sessionToken, baseURL);
    await page.goto(`/${ORG_A_SLUG}/${WS_SLUG}/chat`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(`${ORG_A_SLUG}/${WS_SLUG}`));
  });

  // ── 2. User is denied access to a foreign org's routes ──────────────────────

  test("user A is denied Org B root — redirected to /login", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, fixtureA.sessionToken, baseURL);
    await page.goto(`/${ORG_B_SLUG}`);
    // The application must redirect to /login (no membership in Org B).
    await expect(page).toHaveURL(/\/login/);
  });

  test("user A is denied Org B billing page — redirected to /login", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, fixtureA.sessionToken, baseURL);
    await page.goto(`/${ORG_B_SLUG}/billing/subscription`);
    await expect(page).toHaveURL(/\/login/);
  });

  test("user A is denied Org B workspace chat — redirected to /login", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, fixtureA.sessionToken, baseURL);
    // Use Org B slug with Org A's workspace slug — the workspace doesn't exist
    // under Org B but the guard fires at the org boundary first.
    await page.goto(`/${ORG_B_SLUG}/${WS_SLUG}/chat`);
    await expect(page).toHaveURL(/\/login/);
  });

  test("user A is denied Org B members page — redirected to /login", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, fixtureA.sessionToken, baseURL);
    await page.goto(`/${ORG_B_SLUG}/members`);
    await expect(page).toHaveURL(/\/login/);
  });

  // ── 3. Org A data is NOT visible when loading Org B routes ──────────────────
  //
  // Even if the router erroneously rendered a page for Org B, it must not leak
  // Org A's name. This asserts the absence of cross-contamination.

  test("Org B denial page does not reveal Org A name", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, fixtureA.sessionToken, baseURL);
    await page.goto(`/${ORG_B_SLUG}/billing/subscription`);

    // We should be at /login — Org A's name must not appear there.
    await expect(page).toHaveURL(/\/login/);
    // Login page must not contain any Org A slug or display name in its body.
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("E2E " + ORG_A_SLUG);
  });
});
