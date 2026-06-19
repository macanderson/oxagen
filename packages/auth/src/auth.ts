import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema, withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { requireEnv } from "@oxagen/config/env";
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";
import { buildAccountTokenHooks, buildStripOnlyAccountHooks } from "./token-encryption";
import { sendEmail, resetPasswordEmailTemplate, emailVerificationTemplate } from "@oxagen/notifications";

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

const isLocalEnv =
  env.NODE_ENV === "development" ||
  env.NODE_ENV === "test" ||
  process.env.VERCEL_ENV === "development" ||
  isE2E;

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
// interim Vercel domains to oxagen.ai is a one-line env change, not a
// code change.
//
// BETTER_AUTH_TRUSTED_ORIGINS may be a comma-separated list of origins.
// The production Vercel domains are unconditionally included; local dev
// origins are added when NODE_ENV is not "production".
// ---------------------------------------------------------------------------
const envTrustedOrigins: string[] = process.env.BETTER_AUTH_TRUSTED_ORIGINS
  ? process.env.BETTER_AUTH_TRUSTED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : [];

// Production app origins trusted for CSRF / OAuth redirect validation.
// Interim Vercel-managed domains AND the branded oxagen.ai domains are both
// listed so the brand-domain cutover needs no auth code change. Additional
// per-environment origins can still be appended via BETTER_AUTH_TRUSTED_ORIGINS.
const PROD_ORIGINS = [
  // Interim Vercel-managed domains.
  "https://oxagen-v2-app.vercel.app",
  "https://oxagen-v2-website.vercel.app",
  "https://oxagen-v2-api.vercel.app",
  "https://oxagen-v2-admin.vercel.app",
  // Branded oxagen.ai domains.
  "https://app.oxagen.ai",
  // Stable preview alias — a Vercel branch-tracking domain that always serves
  // the latest preview deployment, so Google OAuth (which forbids wildcard
  // redirect URIs) works on previews via this one fixed hostname.
  "https://preview-app.oxagen.ai",
  "https://oxagen.ai",
  "https://www.oxagen.ai",
  "https://api.oxagen.ai",
  "https://admin.oxagen.ai",
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
    // request when storage:"database" rate limiting is enabled (prod-only — it is
    // disabled in dev, which is why this only ever 500'd in production). Maps to
    // the auth.rate_limit table (migration 0009).
    schema: {
      users: schema.users,
      sessions: schema.sessions,
      accounts: schema.accounts,
      verifications: schema.verifications,
      rateLimits: schema.rateLimitTable,
    },
    usePlural: true,
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // OXA-1504: CSRF / redirect validation. The baseURL origin is automatically
  // trusted by Better Auth; these additional origins cover the app surfaces and
  // dev localhost. See PROD_ORIGINS / DEV_ORIGINS constants above.
  trustedOrigins,
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
      void sendEmail({
        to: user.email,
        ...resetPasswordEmailTemplate({ resetUrl: url, email: user.email }),
      });
    },
  },

  // ---------------------------------------------------------------------------
  // Email verification — send a one-time token to the user's email address
  // upon sign-up and on each sign-in when the email is still unverified.
  // Uses fire-and-forget (void) so the auth flow returns immediately.
  // ---------------------------------------------------------------------------
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      void sendEmail({
        to: user.email,
        ...emailVerificationTemplate({ verificationUrl: url, email: user.email }),
      });
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
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "github"],
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
    account: kmsAdapter
      ? buildAccountTokenHooks(kmsAdapter, TOKEN_KEY_ID)
      : buildStripOnlyAccountHooks(),
    session: {
      create: {
        after: async (session) => {
          // better-auth's Session type uses camelCase property names.
          const s = session as {
            userId: string;
            ipAddress?: string | null;
            userAgent?: string | null;
          };
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
        },
      },
      delete: {
        after: async (session) => {
          const s = session as {
            userId: string;
            ipAddress?: string | null;
            userAgent?: string | null;
          };
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
        },
      },
    },
  },
});

export type Auth = typeof auth;
export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;
