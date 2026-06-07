/**
 * seed-oauth-user.ts — DB fixture for an OAuth-only user (no password credential).
 *
 * Creates an auth.users row + a single social auth.accounts row (providerId "github"),
 * no credential account, plus a valid auth.sessions row and org/workspace membership.
 *
 * This fixture produces a state where:
 *   - The app considers the user fully authenticated (valid session cookie).
 *   - `auth.api.listUserAccounts` returns only a "github" account → hasPassword=false.
 *   - `auth.api.setPassword` will SUCCEED (no credential account exists yet).
 *
 * The session is injected into the Playwright BrowserContext via the same
 * raw cookie-injection mechanism used by the other seeded fixtures. The
 * session token is used as both the `id` and `token` columns (Better Auth
 * resolves sessions by token; using the same value for both keeps the fixture
 * simple and matches the pattern in seed-plugin.ts / agent-runtime-fixture.ts).
 *
 * Parallel-safe: all public IDs are derived from a random 6-byte hex string.
 * Idempotent: all inserts use ON CONFLICT DO NOTHING or DO UPDATE.
 * No org/workspace is required for the set-password flow — the profile page
 * is account-scoped (`/account/profile`) and does not need a workspace slug.
 * We still seed an org + workspace so the post-login redirect has a valid
 * target and the membership rows satisfy any RLS policies that read org context.
 */

import postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { BrowserContext } from "@playwright/test";

// ---------------------------------------------------------------------------
// DB connection — mirrors the pattern in seed-plugin.ts / seed-subscription.ts.
// ---------------------------------------------------------------------------

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

function uid(): string {
  return randomBytes(6).toString("hex");
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OAuthUserFixture {
  /** The seeded user's email address. */
  email: string;
  /** The internal UUID of the seeded user row. */
  userId: string;
  /** The session token (also used as session id). */
  sessionToken: string;
  /** Org slug — navigate to /{orgSlug}/default for a valid post-login page. */
  orgSlug: string;
  /** Workspace slug. */
  workspaceSlug: string;
  /**
   * Remove all rows created by this fixture.
   * Call in afterAll / afterEach to keep the local DB tidy.
   */
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// seedOAuthOnlyUser
// ---------------------------------------------------------------------------

/**
 * Inserts:
 *   - org.organizations
 *   - auth.users
 *   - workspace.workspaces
 *   - org.org_users + workspace.workspace_users (owner role)
 *   - auth.accounts (providerId="github", no password column set)
 *   - auth.sessions (valid for 1 hour)
 *
 * Then injects the session cookie into `context` so Playwright can navigate
 * to auth-gated pages as this user.
 *
 * @param context  Playwright BrowserContext to inject the session cookie into.
 * @param baseUrl  App base URL (e.g. "http://localhost:3000"). Defaults to
 *                 process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000".
 */
export async function seedOAuthOnlyUser(
  context: BrowserContext,
  baseUrl: string = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
): Promise<OAuthUserFixture> {
  const id = uid();
  const email = `e2e-oauth-${id}@oxagen.test`;
  const orgSlug = `e2e-oauth-${id}`;
  const workspaceSlug = "default";

  const sql = postgres(DATABASE_URL, { max: 3, prepare: false });

  try {
    // ── Organization ─────────────────────────────────────────────────────────
    const [orgRow] = await sql<{ id: string }[]>`
      INSERT INTO org.organizations (public_id, name, slug, plan_type, status)
      VALUES ('org_e2e_' || ${id}, ${"E2E OAuth " + id}, ${orgSlug}, 'free', 'active')
      ON CONFLICT (slug) DO UPDATE SET status = 'active'
      RETURNING id
    `;
    if (!orgRow) throw new Error("seedOAuthOnlyUser: org insert returned no row");
    const orgId = orgRow.id;

    // ── User ─────────────────────────────────────────────────────────────────
    const [userRow] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (public_id, email, display_name, status, email_verified, email_verified_at)
      VALUES ('usr_e2e_' || ${id}, ${email}, 'E2E OAuth User', 'active', true, now())
      ON CONFLICT (email) DO UPDATE SET status = 'active'
      RETURNING id
    `;
    if (!userRow) throw new Error("seedOAuthOnlyUser: user insert returned no row");
    const userId = userRow.id;

    // ── Workspace ─────────────────────────────────────────────────────────────
    const [wsRow] = await sql<{ id: string }[]>`
      INSERT INTO workspace.workspaces (public_id, org_id, name, slug)
      VALUES ('wrk_e2e_' || ${id}, ${orgId}, 'Default', ${workspaceSlug})
      ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    if (!wsRow) throw new Error("seedOAuthOnlyUser: workspace insert returned no row");
    const workspaceId = wsRow.id;

    // ── Memberships ───────────────────────────────────────────────────────────
    await sql`
      INSERT INTO org.org_users (public_id, org_id, user_id, role, joined_at)
      VALUES ('oru_e2e_' || ${id}, ${orgId}, ${userId}, 'owner', now())
      ON CONFLICT (org_id, user_id) DO NOTHING
    `;
    await sql`
      INSERT INTO workspace.workspace_users (public_id, workspace_id, user_id, role, joined_at)
      VALUES ('wsu_e2e_' || ${id}, ${workspaceId}, ${userId}, 'owner', now())
      ON CONFLICT (workspace_id, user_id) DO NOTHING
    `;

    // ── Auth account: GitHub (social) — NO password column ───────────────────
    // providerId = "github", accountId = the user's email (mirrors how Better
    // Auth normalises GitHub accounts when the user has no GitHub username set).
    // password is intentionally omitted (NULL) — this is what makes the account
    // "OAuth-only": auth.api.listUserAccounts returns this row and hasPassword
    // is derived as `accounts.some(a => a.providerId === "credential")` which
    // is FALSE here.
    const accountId = `e2e-github-account-${id}`;
    await sql`
      INSERT INTO auth.accounts (
        id, user_id, account_id, provider_id,
        created_at, updated_at
      )
      VALUES (
        ${accountId},
        ${userId},
        ${email},
        'github',
        now(),
        now()
      )
      ON CONFLICT (provider_id, account_id) DO NOTHING
    `;

    // ── Session ───────────────────────────────────────────────────────────────
    // Both `id` and `token` are set to the same value — Better Auth resolves
    // sessions by the `token` column. This matches how seed-plugin.ts works.
    const sessionToken = `e2e-oauth-session-${id}`;
    await sql`
      INSERT INTO auth.sessions (id, token, user_id, expires_at, ip_address, user_agent, created_at, updated_at)
      VALUES (
        ${sessionToken},
        ${sessionToken},
        ${userId},
        now() + interval '1 hour',
        '127.0.0.1',
        'playwright-e2e',
        now(),
        now()
      )
      ON CONFLICT (id) DO NOTHING
    `;

    // ── Inject session cookie into Playwright context ─────────────────────────
    // Better Auth derives the cookie name as `${cookiePrefix}.session_token`.
    // This app sets cookiePrefix to "oxagen" (packages/auth/src/resolvers/session.ts
    // SESSION_COOKIE_NAME = "oxagen.session_token" — OXA-1497).
    // The `__Secure-` prefix is suppressed in E2E via the E2E_TEST=true env var,
    // so the plain name is used here.
    //
    // The cookie value is the session token exactly as stored in auth.sessions.
    const url = new URL(baseUrl);
    await context.addCookies([
      {
        name: "oxagen.session_token",
        value: sessionToken,
        domain: url.hostname,
        path: "/",
        httpOnly: true,
        secure: false, // E2E runs over http; E2E_TEST=true suppresses __Secure- prefix
        sameSite: "Lax",
        expires: Math.floor(Date.now() / 1000) + 60 * 60, // 1 hour
      },
    ]);

    // ── Cleanup factory ───────────────────────────────────────────────────────
    const cleanup = async (): Promise<void> => {
      const csql = postgres(DATABASE_URL, { max: 2, prepare: false });
      try {
        await csql`DELETE FROM auth.sessions WHERE id = ${sessionToken}`;
        await csql`DELETE FROM auth.accounts WHERE id = ${accountId}`;
        await csql`DELETE FROM workspace.workspace_users WHERE workspace_id = ${workspaceId}`;
        await csql`DELETE FROM workspace.workspaces WHERE id = ${workspaceId}`;
        await csql`DELETE FROM org.org_users WHERE org_id = ${orgId}`;
        await csql`DELETE FROM auth.users WHERE id = ${userId}`;
        await csql`DELETE FROM org.organizations WHERE id = ${orgId}`;
      } finally {
        await csql.end({ timeout: 5 });
      }
    };

    return { email, userId, sessionToken, orgSlug, workspaceSlug, cleanup };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
