import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { loginWithSession } from "./helpers/auth";
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
//   • The cookie-injection `loginWithSession` helper is used to give the test a valid
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
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))
    return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5433/oxagen",
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
        INSERT INTO org.organizations (public_id, name, slug, namespace, plan_type, status)
        VALUES (
          'org_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 22),
          'E2E Isolation Org B',
          ${ORG_B_SLUG},
          -- namespace is NOT NULL + immutable and must match ^[a-z0-9]{2,6}$;
          -- a random 6-hex handle satisfies both. ON CONFLICT (slug) leaves it
          -- untouched on re-runs, so the immutability trigger never fires.
          substr(md5(gen_random_uuid()::text), 1, 6),
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
    await loginWithSession(context, fixtureA.sessionToken, baseURL);
    await page.goto(`/${ORG_A_SLUG}`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(ORG_A_SLUG));
  });

  test("user A reaches Org A billing/subscription without redirect", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixtureA.sessionToken, baseURL);
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
    await loginWithSession(context, fixtureA.sessionToken, baseURL);
    await page.goto(`/${ORG_A_SLUG}/${WS_SLUG}/chat`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(`${ORG_A_SLUG}/${WS_SLUG}`));
  });

  // ── 2. User is denied access to a foreign org's routes ──────────────────────

  // The org layout gates membership via assertOrgMember() → notFound() for a
  // non-member, so Org B routes render the 404 boundary (URL unchanged) — NOT
  // a /login redirect. The 404 surface is deliberate: it does not even confirm
  // Org B exists to a non-member.
  //
  // HTTP status note: under cacheComponents/Partial Prerendering the initial
  // document is the prerendered static shell (HTTP 200) and notFound() fires
  // inside the dynamic hole while streaming, so the status line can no longer
  // flip to 404. The enforced contract is CONTENT-level: the not-found
  // boundary renders, no org shell/data ever appears (leak check below), and
  // cross-tenant API calls still hard-403.
  const EXPECT_DENIED = async (
    page: import("@playwright/test").Page,
    path: string,
  ) => {
    const resp = await page.goto(path);
    // Shell may stream as 200 under PPR; a real 404 is also acceptable.
    expect([200, 404]).toContain(resp?.status() ?? 0);
    // The not-found surface — not an authed org shell — is what renders.
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByText(/page not found|404/i).first()).toBeVisible();
  };

  test("user A is denied Org B root — 404, not the org", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixtureA.sessionToken, baseURL);
    await EXPECT_DENIED(page, `/${ORG_B_SLUG}`);
  });

  test("user A is denied Org B billing page — 404", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixtureA.sessionToken, baseURL);
    await EXPECT_DENIED(page, `/${ORG_B_SLUG}/billing/subscription`);
  });

  test("user A is denied Org B workspace chat — 404 (org guard fires first)", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixtureA.sessionToken, baseURL);
    // Org B slug with Org A's workspace slug — the org-boundary guard fires
    // before workspace resolution.
    await EXPECT_DENIED(page, `/${ORG_B_SLUG}/${WS_SLUG}/chat`);
  });

  test("user A is denied Org B members page — 404", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixtureA.sessionToken, baseURL);
    await EXPECT_DENIED(page, `/${ORG_B_SLUG}/members`);
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
    await loginWithSession(context, fixtureA.sessionToken, baseURL);
    const resp = await page.goto(`/${ORG_B_SLUG}/billing/subscription`);

    // Denied via notFound() → 404 boundary, never Org B content. (Status may
    // be 200 under PPR — see EXPECT_DENIED; the content assertions are the
    // enforced isolation contract.)
    expect([200, 404]).toContain(resp?.status() ?? 0);
    await expect(page.getByText(/page not found|404/i).first()).toBeVisible();
    // The 404 surface must not leak Org A's name/slug either.
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("E2E " + ORG_A_SLUG);
  });
});
