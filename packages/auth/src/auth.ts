import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";
import { buildOAuthProxyPlugins } from "./oauth-proxy-config";
import { eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema, withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { captureError } from "@oxagen/telemetry";
import { requireEnv } from "@oxagen/config/env";
import { logger } from "./logger";
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";
import { buildAccountTokenHooks, buildStripOnlyAccountHooks } from "./token-encryption";
import { withTrustedLinkHardening } from "./account-linking";
import { resolveIsLocalEnv } from "./local-env";
import {
  sendEmailFireAndForget,
  resetPasswordEmailTemplate,
  emailVerificationTemplate,
} from "@oxagen/notifications";

// Better Auth binds to the canonical auth.users row, not a parallel table.
// The Drizzle adapter looks up columns via JS property lookup
// (`schemaModel[fieldName]`), so the fields map must use camelCase Drizzle
// field names — Drizzle handles the camelCase → snake_case translation when
// it emits SQL.
const env = requireEnv([
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "NODE_ENV",
  // LOGIN client — social sign-in. The DATA clients (GOOGLE_DATA_CLIENT_ID/
  // SECRET, GITHUB_DATA_CLIENT_ID/SECRET) are reserved for future data
  // connections (google-workspace, github repo ingestion) and are
  // intentionally NOT wired into social login.
  "GOOGLE_LOGIN_CLIENT_ID",
  "GOOGLE_LOGIN_CLIENT_SECRET",
  "GITHUB_LOGIN_CLIENT_ID",
  "GITHUB_LOGIN_CLIENT_SECRET",
] as const);

// ---------------------------------------------------------------------------
// OXA-1504: Startup guard — AUTH_TOKEN_ENCRYPTION_KEY must be set in non-local
// environments so that OAuth token encryption is NEVER silently skipped in
// production.  In local/development the key is optional so engineers can boot
// without it.  This is a Vercel-native master key (KEK) held in encrypted env
// storage — no cloud KMS / AWS dependency.
// ---------------------------------------------------------------------------
const tokenEncryptionKey = process.env.AUTH_TOKEN_ENCRYPTION_KEY;

// Logical key-version label, stored per-row in `tokenKmsKeyId` so a future key
// rotation can identify which master key wrapped each row. Bump on rotation.
const TOKEN_KEY_ID = "vercel-native-v1";

// E2E_TEST is injected by playwright.config.ts webServer.env when running
// `next start` in CI. Playwright drives a production build over http, so
// NODE_ENV is "production" even though several production-only behaviors
// (secure cookies, OAuth token encryption, brute-force rate limiting) must be
// relaxed for the deterministic test harness. This single flag gates all of
// those E2E exemptions.
const isE2E = process.env.E2E_TEST === "true";

// Single source of truth (see local-env.ts). The explicit OXAGEN_LOCAL_DEV flag
// — set for the whole stack by tools/scripts/dev.ts — makes local detection
// deterministic instead of racing NODE_ENV at module-load time (OXA-1752). It is
// ignored on real Vercel deploys, so it can never relax production.
const isLocalEnv = resolveIsLocalEnv({
  nodeEnv: env.NODE_ENV,
  vercel: process.env.VERCEL,
  vercelEnv: process.env.VERCEL_ENV,
  e2eTest: process.env.E2E_TEST,
  localDevFlag: process.env.OXAGEN_LOCAL_DEV,
});

// The master key is a RUNTIME requirement, not a build-time one. Next.js
// evaluates route modules during `next build` ("Collecting page data") with
// NEXT_PHASE=phase-production-build set, and the build environment legitimately
// lacks the runtime secret — failing the build here is wrong. The guard still
// fires at server boot / request time (NEXT_PHASE unset), so production can
// still never boot without OAuth token encryption configured (OXA-1504).
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

if (!tokenEncryptionKey && !isLocalEnv && !isBuildPhase) {
  throw new Error(
    "[auth] AUTH_TOKEN_ENCRYPTION_KEY is required in non-local environments. " +
      "Production cannot boot without OAuth token encryption configured (OXA-1504).",
  );
}

// OXA-1420: native envelope-encryption adapter for OAuth tokens.
// Only created when AUTH_TOKEN_ENCRYPTION_KEY is present so that development /
// local builds without the key can still boot.
const kmsAdapter = tokenEncryptionKey
  ? createLocalKmsAdapter(loadMasterKey(tokenEncryptionKey))
  : null;

// ---------------------------------------------------------------------------
// Security audit setup
//
// emitSecurityEvent (from @oxagen/database/security) writes through the shared
// process-wide inserter, which uses withSystemDb internally. These emits run
// inside Better Auth lifecycle hooks (session.create/delete) where no tenant
// scope has been established yet — the session itself is the identity signal
// (tenancy: system bypass — OXA-1515).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// resolveFirstOrgId — resolve an orgId for a given userId so that
// auth lifecycle events can be scoped to an org.
//
// LIMITATION (flagged for follow-up — OXA-1422):
//   A user may belong to multiple orgs. The sign-in event emits once using
//   the user's *first* org membership (ORDER BY joined_at ASC). Multi-org
//   users will see a sign-in event for their oldest org only. The correct
//   long-term fix is to add org_id to the session (populated from the
//   workspace-selection flow), then read session.orgId here.
// ---------------------------------------------------------------------------

async function resolveFirstOrgId(userId: string): Promise<string | null> {
  // tenancy: system bypass via withSystemDb (identity resolution before a tenant scope exists) — OXA-1515
  // Resolves the user's first org membership so that auth lifecycle events
  // (sign_in / sign_out) can be tagged with an orgId for the audit trail.
  // This lookup IS the identity resolution step — a tenant scope cannot exist
  // until after this function returns the orgId.
  const rows = await withSystemDb((tx) =>
    tx
      .select({ orgId: schema.orgUsers.orgId })
      .from(schema.orgUsers)
      .where(eq(schema.orgUsers.userId, userId))
      .orderBy(schema.orgUsers.joinedAt)
      .limit(1),
  );
  return rows[0]?.orgId ?? null;
}

// Sentinel used when no org membership exists yet (e.g. user just signed up,
// org provisioning is async). Events with this orgId are valid audit rows and
// can be disambiguated in compliance queries via `actor_user_id`.
const NO_ORG_SENTINEL = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// OXA-1504: Trusted origins — built from env vars so switching from the
// interim Vercel domains to oxagen.sh is a one-line env change, not a
// code change.
//
// BETTER_AUTH_TRUSTED_ORIGINS may be a comma-separated list of origins.
// The production Vercel domains are unconditionally included; local dev
// origins are added when NODE_ENV is not "production".
// ---------------------------------------------------------------------------
const envTrustedOrigins: string[] = process.env.BETTER_AUTH_TRUSTED_ORIGINS
  ? process.env.BETTER_AUTH_TRUSTED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : [];

// Production app origins trusted for CSRF / OAuth redirect validation. The
// brand-domain cutover already landed (both the app and marketing surfaces
// live under oxagen.sh), so this is a single flat list rather than separate
// "interim" and "branded" sets. Additional per-environment origins can still
// be appended via BETTER_AUTH_TRUSTED_ORIGINS.
const PROD_ORIGINS = [
  "https://app.oxagen.sh",
  "https://www.oxagen.sh",
  "https://api.oxagen.sh",
  "https://admin.oxagen.sh",
  "https://oxagen.sh",
  // Stable preview alias — a Vercel branch-tracking domain that always serves
  // the latest preview deployment, so Google OAuth (which forbids wildcard
  // redirect URIs) works on previews via this one fixed hostname.
  "https://preview-app.oxagen.sh",
];

// Local dev origins — only included in non-production so they cannot
// accidentally appear in a prod config if the guard above is ever removed.
const DEV_ORIGINS =
  env.NODE_ENV !== "production"
    ? [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:8787",
      ]
    : [];

const trustedOrigins: string[] = [
  ...PROD_ORIGINS,
  ...DEV_ORIGINS,
  ...envTrustedOrigins,
];

// ---------------------------------------------------------------------------
// OXA-1789: Multi-environment social login via Better Auth's OAuth Proxy.
//
// A GitHub OAuth App (and a Google OAuth client) allows only ONE callback host.
// We share a SINGLE login OAuth app across production (app.oxagen.sh) and every
// preview deployment (preview-app.oxagen.sh, …), so a naive setup can satisfy
// only ONE host — the other 403s with GitHub's "The redirect_uri is not
// associated with this application" (the exact prod break after the oxagen.sh
// domain migration).
//
// oAuthProxy resolves this. The OAuth app is registered with the PRODUCTION
// callback ONLY — `${OAUTH_PROXY_PRODUCTION_URL}/api/auth/callback/<provider>`:
//   • Production: the proxy detects currentURL origin === productionURL origin
//     and SKIPS entirely — a pure passthrough, identical to today's behavior
//     (the shared secret is never even read on this path).
//   • Preview: the proxy rewrites the outgoing redirect_uri to the production
//     callback, lets production exchange the OAuth `code`, then relays the
//     authenticated session back to the preview origin inside a payload
//     encrypted with the shared secret — so the cookie lands on the preview
//     host. Preview origins must be trusted (preview-app.oxagen.sh is in
//     PROD_ORIGINS); access previews via that stable alias for OAuth.
//
// PREVIEW REQUIREMENTS (production needs neither — it only passes through):
//   1. The login OAuth app callback URL = `${OAUTH_PROXY_PRODUCTION_URL}/api/auth/callback/<provider>`.
//   2. OAUTH_PROXY_SECRET set to the SAME value in production AND preview, so
//      production can encrypt and preview can decrypt the relay payload. It is
//      a DEDICATED secret (not BETTER_AUTH_SECRET) so a key shared across
//      environments cannot forge sessions or decrypt anything protected by the
//      main secret. We fall back to BETTER_AUTH_SECRET only so the plugin can
//      boot; cross-environment relay needs the dedicated shared secret set.
//
// DISABLED in local dev: local uses a separate dev OAuth app with a localhost
// callback, and proxying localhost through production would break local sign-in.
// The pure, unit-tested implementation lives in ./oauth-proxy-config.
// ---------------------------------------------------------------------------
const oauthProxyPlugins = buildOAuthProxyPlugins({
  isLocalEnv,
  productionUrlEnv: process.env.OAUTH_PROXY_PRODUCTION_URL,
  proxySecretEnv: process.env.OAUTH_PROXY_SECRET,
  betterAuthSecret: env.BETTER_AUTH_SECRET,
});

export const auth = betterAuth({
  // tenancy: unscoped seam (identity resolution before a tenant scope exists) — OXA-1515
  // The Drizzle adapter is handed the global db() connection so Better Auth can
  // read/write the auth.users, auth.sessions, auth.accounts, and
  // auth.verifications tables. These are global identity tables (no RLS) and
  // this db() call is the bootstrap point for all session/user resolution —
  // no tenant scope exists at this layer.
  database: drizzleAdapter(db(), {
    provider: "pg",
    // Better Auth resolves models by name; with usePlural=true EVERY model name
    // is pluralized for schema-key lookup — user→users, session→sessions, and
    // critically the rate-limiter's internal model rateLimit→rateLimits. The key
    // here must therefore be the PLURAL "rateLimits" (not "rateLimit"), or the
    // Drizzle adapter throws `model "rateLimits" was not found` on EVERY auth
    // request. storage:"database" rate limiting is enabled in every environment
    // except the E2E harness (`enabled: !isE2E` below), so this mapping — and a
    // reachable Postgres — is exercised on every sign-in/sign-up in LOCAL DEV too,
    // not just production. A DB outage therefore 500s auth in dev as well (it
    // surfaces as ECONNREFUSED on the auth.rate_limit query). Maps to the
    // auth.rate_limit table (migration 0009).
    schema: {
      users: schema.users,
      sessions: schema.sessions,
      accounts: schema.accounts,
      verifications: schema.verifications,
      rateLimits: schema.rateLimitTable,
      // usePlural pluralizes the twoFactor model → "twoFactors". The physical
      // table is auth.two_factor; this key MUST be the plural form or the
      // adapter throws `model "twoFactors" was not found` on every 2FA call
      // (same class of bug as rateLimit→rateLimits).
      twoFactors: schema.twoFactorTable,
    },
    usePlural: true,
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // OXA-1504: CSRF / redirect validation. The baseURL origin is automatically
  // trusted by Better Auth; these additional origins cover the app surfaces and
  // dev localhost. See PROD_ORIGINS / DEV_ORIGINS constants above.
  trustedOrigins,
  // OXA-1789: OAuth Proxy — passthrough in production, relays preview social
  // logins through the production callback. Empty in local dev. See the
  // oauthProxyPlugins note above.
  //
  // twoFactor: TOTP-based 2FA. Backed by auth.two_factor (mapped as the plural
  // model key "twoFactors" above). Secrets + backup codes are encrypted at rest
  // with BETTER_AUTH_SECRET. The enrollment/verify/disable endpoints are
  // auto-mounted under /api/auth/two-factor/*; enforcement for privileged
  // (owner/admin) roles lives in the app's org layout gate, not here. The
  // issuer labels the entry in the user's authenticator app.
  // twoFactor() is widened to BetterAuthPlugin so its internal zod schema types
  // don't leak into the inferred `auth` type — that leak drags zod's `$strip`
  // symbol in and trips TS2883 ("inferred type cannot be named"). The cast is
  // type-only; the plugin's endpoints still mount at runtime.
  plugins: [
    ...oauthProxyPlugins,
    twoFactor({ issuer: "Oxagen" }) as BetterAuthPlugin,
  ],
  user: {
    fields: {
      name: "displayName",
      image: "avatarUrl",
    },
    additionalFields: {
      status: { type: "string", required: false, defaultValue: "active" },
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
    // Require a verified email before sign-in in deployed (production/preview)
    // environments only. Local development and the E2E harness have no real
    // mail delivery (sendEmail is a no-op locally), so enforcing it would 403
    // every credential sign-in and block all local frontend verification. Gated
    // on isLocalEnv (NODE_ENV development/test, VERCEL_ENV development, or E2E).
    requireEmailVerification: !isLocalEnv,
    // Tokens expire after 1 hour (Better Auth default). Single-use — deleted
    // on first successful reset. revokeSessionsOnPasswordReset invalidates all
    // existing sessions so a hijacked account is secured immediately.
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      // Fire-and-forget: Better Auth's timing-attack mitigation requires that
      // the response is returned before the email dispatch completes. We void
      // the promise so the function returns synchronously; the email is sent
      // in the background. The backgroundTasks.handler is not configured here
      // because Vercel's serverless execution keeps the function alive long
      // enough for a single sendEmail call (< 300 ms typical SMTP).
      sendEmailFireAndForget(
        {
          to: user.email,
          ...resetPasswordEmailTemplate({ resetUrl: url, email: user.email }),
        },
        "password-reset",
      );
    },
  },

  // ---------------------------------------------------------------------------
  // Email verification — send a one-time token to the user's email address
  // upon sign-up and on each sign-in when the email is still unverified.
  // Uses fire-and-forget (void) so the auth flow returns immediately.
  // ---------------------------------------------------------------------------
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      sendEmailFireAndForget(
        {
          to: user.email,
          ...emailVerificationTemplate({ verificationUrl: url, email: user.email }),
        },
        "verification",
      );
    },
    sendOnSignIn: true,
  },

  // ---------------------------------------------------------------------------
  // OXA-SOC2: Brute-force defense — database-backed rate limiting.
  //
  // `storage: "database"` is the only option that survives across Vercel
  // serverless instances (memory resets on cold-start). The auth.rate_limit
  // table (migration 0009) stores (id, key, count, lastRequest). The Drizzle
  // adapter resolves the pluralized model name "rateLimits" → schema.rateLimitTable
  // (see the schema map above; usePlural pluralizes the model key).
  //
  // Base: 100 req / 60 s (well above normal interactive usage).
  // Sign-in email: 5 req / 60 s (SOC2-grade: 5 attempts before lockout).
  // Sign-up email: 10 req / 60 s (generous for legitimate sign-up flows).
  // Note: Better Auth also applies a built-in default rule of 3 req / 10 s
  // for /sign-in/* and /sign-up/* paths; our customRules below OVERRIDE
  // that with the SOC2-appropriate 5/60 and 10/60 windows.
  //
  // E2E EXEMPTION: the Playwright suite signs in / signs up dozens of times in
  // rapid succession from a single loopback IP (one shared rate-limit bucket),
  // which legitimately exceeds the 5/60 sign-in and 10/60 sign-up windows and
  // 429s the harness — not an attack. No e2e test asserts rate-limit behavior,
  // so disabling it under E2E_TEST is lossless. Production and dev keep the
  // full SOC2 brute-force defense; only the deterministic test build relaxes it.
  // ---------------------------------------------------------------------------
  rateLimit: {
    enabled: !isE2E,
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 10 },
    },
  },
  socialProviders: {
    google:
      env.GOOGLE_LOGIN_CLIENT_ID && env.GOOGLE_LOGIN_CLIENT_SECRET
        ? {
            clientId: env.GOOGLE_LOGIN_CLIENT_ID,
            clientSecret: env.GOOGLE_LOGIN_CLIENT_SECRET,
            // Explicit minimal scopes — prevents Google Cloud Console pre-authorized
            // scopes from silently expanding the consent screen.
            scope: ["openid", "profile", "email"],
          }
        : undefined,
    github:
      env.GITHUB_LOGIN_CLIENT_ID && env.GITHUB_LOGIN_CLIENT_SECRET
        ? { clientId: env.GITHUB_LOGIN_CLIENT_ID, clientSecret: env.GITHUB_LOGIN_CLIENT_SECRET }
        : undefined,
  },
  // Account linking — never create a duplicate user. Google and GitHub both
  // verify the email they return, so they are trusted: when an OAuth sign-in's
  // email matches an existing user, the new provider is linked to that user
  // instead of creating a second account. After linking, the user can sign in
  // with email/password (if set), Google, or GitHub interchangeably. GitHub can
  // expose multiple emails — Better Auth matches on the primary verified email.
  //
  // requireLocalEmailVerified: false — without this, Better Auth REFUSES to link
  // a trusted provider into an existing local account whose email is still
  // unverified, surfacing as `account_not_linked` (better-auth
  // `oauth2/link-account.mjs`: `requireLocalEmailVerified && !user.emailVerified`).
  // That blocks the common, legitimate flow "I signed up with a password, never
  // verified, now I sign in with Google" and forces a duplicate-or-dead-end. We
  // accept the trusted provider's verified email as proof of ownership and link.
  //
  // SECURITY: relaxing this alone would open an account pre-hijacking vector
  // (an attacker pre-registers victim@x with a password they choose; the
  // victim's later Google sign-in links + verifies that row, enabling the
  // attacker's password). That hole is closed by withTrustedLinkHardening below,
  // which revokes any stale credential password when a trusted provider links
  // into a previously-unverified account. See ./account-linking.ts.
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "github"],
      requireLocalEmailVerified: false,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    // cookieCache intentionally omitted — Better Auth defaults to disabled.
    // Enabling it caused RSC-render failures: when the 5-minute cache expired,
    // Better Auth tried to call response.headers.set() to refresh the session
    // cookie during an RSC render. Next.js 16 forbids cookie writes outside
    // Server Actions / Route Handlers, producing a Runtime APIError:
    // "Failed to get session". Session reads from the DB on each request are
    // acceptable at this stage.
  },
  advanced: {
    cookiePrefix: "oxagen",
    // Secure cookies in production — EXCEPT under E2E, where Playwright drives
    // a production build (`next start`) over http://localhost. `__Secure-`
    // cookies are never sent over http, so the e2e auth helper could never
    // inject a session. The flag is set only by the Playwright webServer.
    useSecureCookies: env.NODE_ENV === "production" && !isE2E,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
    },
    // users.id is a uuid column (idMixin). Better Auth's default ID generator
    // produces nanoid-style strings that postgres rejects when cast to uuid.
    database: {
      generateId: () => crypto.randomUUID(),
    },
  },

  // ---------------------------------------------------------------------------
  // Database hooks — merged from OXA-1420 (account token encryption) and
  // OXA-1422 (security audit events).
  //
  // OXA-1420: account.create.before / account.update.before
  //   Encrypt OAuth access_token, refresh_token, id_token into *_enc bytea
  //   columns before any account row is written.  CONTRACT PHASE — migration
  //   0012 has dropped the plaintext access_token and refresh_token columns;
  //   the hooks now write ONLY to the *_enc columns.
  //
  // OXA-1422: session.create.after / session.delete.after
  //   Emit auth.sign_in / auth.sign_out into security.security_events for
  //   SOC2 / audit trail.
  //
  // FLAGGED for follow-up (OXA-1422):
  //   (1) Session expiry (TTL-based) does NOT trigger session.delete.after.
  //       A sweep job must retroactively emit auth.sign_out events for
  //       expired sessions.
  //   (2) Multi-org users: events use the oldest org membership; fix by
  //       adding org_id to the session model.
  //   (3) Failed sign-in: no databaseHooks seam for failed attempts; emit
  //       from the API/MCP sign-in route handler instead.
  // ---------------------------------------------------------------------------
  databaseHooks: {
    // The account hook ALWAYS runs: it must strip the dropped plaintext
    // access_token / refresh_token columns (migration 0012) on every write or
    // OAuth sign-up fails with an "unknown column" error. When
    // AUTH_TOKEN_ENCRYPTION_KEY is present (preview/prod, enforced by the
    // startup guard) the tokens are additionally encrypted into the *_enc
    // columns; locally without the key they're simply not persisted.
    //
    // withTrustedLinkHardening composes onto that base hook: after the token
    // transform, it revokes any stale credential password when a trusted social
    // provider links into a previously-unverified local account (closes the
    // account pre-hijacking vector opened by requireLocalEmailVerified:false —
    // see the accountLinking note above and ./account-linking.ts).
    account: withTrustedLinkHardening(
      kmsAdapter
        ? buildAccountTokenHooks(kmsAdapter, TOKEN_KEY_ID)
        : buildStripOnlyAccountHooks(),
    ),
    session: {
      create: {
        after: async (session) => {
          // better-auth's Session type uses camelCase property names.
          const s = session as {
            userId: string;
            ipAddress?: string | null;
            userAgent?: string | null;
          };
          // SECURITY: wrap the entire hook body so a transient DB failure in
          // resolveFirstOrgId cannot propagate through Better Auth's hook runner
          // and turn a successful sign-in into an HTTP 500. The session is
          // already committed by the time this after-hook runs; blocking sign-in
          // for an audit-emit failure would be worse than emitting no event.
          // Log so the gap is visible in ops; never re-throw (OXA-1422).
          try {
            const orgId = await resolveFirstOrgId(s.userId);
            emitSecurityEvent({
              eventType: "auth.sign_in",
              actorUserId: s.userId,
              orgId: orgId ?? NO_ORG_SENTINEL,
              workspaceId: null,
              capability: null,
              outcome: "success",
              ip: s.ipAddress ?? null,
              userAgent: s.userAgent ?? null,
              requestId: null,
            });
          } catch (err) {
            // Best-effort audit — never block sign-in for an audit failure.
            // Route through the package logger (structured, queryable) AND
            // escalate via captureError so a spike in dropped sign-in audit
            // events is alertable — the failure here happens BEFORE
            // emitSecurityEvent's own retry/escalation path could run
            // (resolveFirstOrgId can throw first), so this is the only place it
            // can be surfaced (OXA-2058 companion; never re-throw — OXA-1422).
            logger.error({ userId: s.userId, err }, "[auth] session.create.after hook failed");
            captureError({
              error: err,
              source: "app",
              severity: "warn",
              context: "auth session.create.after hook failed",
            });
          }
        },
      },
      delete: {
        after: async (session) => {
          const s = session as {
            userId: string;
            ipAddress?: string | null;
            userAgent?: string | null;
          };
          // SECURITY: same guard as session.create.after — a transient DB
          // failure must not propagate into Better Auth's hook runner and cause
          // sign-out to 500. The session is already deleted; audit is
          // best-effort (OXA-1422).
          try {
            const orgId = await resolveFirstOrgId(s.userId);
            emitSecurityEvent({
              eventType: "auth.sign_out",
              actorUserId: s.userId,
              orgId: orgId ?? NO_ORG_SENTINEL,
              workspaceId: null,
              capability: null,
              outcome: "success",
              ip: s.ipAddress ?? null,
              userAgent: s.userAgent ?? null,
              requestId: null,
            });
          } catch (err) {
            // Best-effort audit — never block sign-out for an audit failure.
            // Same escalation as session.create.after: structured logger +
            // captureError so dropped sign-out audit events are alertable
            // (OXA-2058 companion; never re-throw — OXA-1422).
            logger.error({ userId: s.userId, err }, "[auth] session.delete.after hook failed");
            captureError({
              error: err,
              source: "app",
              severity: "warn",
              context: "auth session.delete.after hook failed",
            });
          }
        },
      },
    },
  },
});

export type Auth = typeof auth;
export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;
