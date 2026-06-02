import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { KMSClient } from "@aws-sdk/client-kms";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { makeSecurityEventInserter } from "@oxagen/database/security";
import { requireEnv } from "@oxagen/config/env";
import { createAwsKmsAdapter } from "@oxagen/crypto/kms";
import { recordSecurityEvent } from "@oxagen/telemetry";
import { buildAccountTokenHooks } from "./token-encryption";

// Better Auth binds to the canonical auth.users row, not a parallel table.
// The Drizzle adapter looks up columns via JS property lookup
// (`schemaModel[fieldName]`), so the fields map must use camelCase Drizzle
// field names — Drizzle handles the camelCase → snake_case translation when
// it emits SQL.
const env = requireEnv([
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "NODE_ENV",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const);

// ---------------------------------------------------------------------------
// OXA-1504: Startup guard — AUTH_TOKEN_KMS_KEY_ID must be set in non-local
// environments so that OAuth token encryption is NEVER silently skipped in
// production.  In local/development the key is optional so engineers can boot
// without AWS credentials.
// ---------------------------------------------------------------------------
const kmsKeyId = process.env.AUTH_TOKEN_KMS_KEY_ID;
const isLocalEnv =
  env.NODE_ENV === "development" ||
  env.NODE_ENV === "test" ||
  process.env.VERCEL_ENV === "development" ||
  // E2E_TEST is injected by playwright.config.ts webServer.env when running
  // `next start` in CI. Playwright drives a production build over http, so
  // NODE_ENV is "production" even though KMS is unavailable — the same
  // exemption already applied to useSecureCookies (line below).
  process.env.E2E_TEST === "true";

// The KMS key is a RUNTIME requirement, not a build-time one. Next.js evaluates
// route modules during `next build` ("Collecting page data") with
// NEXT_PHASE=phase-production-build set, and the build environment legitimately
// lacks the runtime secret — failing the build here is wrong. The guard still
// fires at server boot / request time (NEXT_PHASE unset), so production can
// still never boot without OAuth token encryption configured (OXA-1504).
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

if (!kmsKeyId && !isLocalEnv && !isBuildPhase) {
  throw new Error(
    "[auth] AUTH_TOKEN_KMS_KEY_ID is required in non-local environments. " +
      "Production cannot boot without OAuth token encryption configured (OXA-1504).",
  );
}

// OXA-1420: KMS adapter for OAuth token envelope encryption.
// Only created when AUTH_TOKEN_KMS_KEY_ID is present so that development /
// local builds without AWS credentials can still boot.
const kmsAdapter =
  kmsKeyId
    ? createAwsKmsAdapter(new KMSClient({ region: "us-east-2" }))
    : null;

// ---------------------------------------------------------------------------
// Security audit setup
//
// auditInsert is created lazily on first use to avoid calling db() at module
// load time (db() requires DATABASE_URL; tests may not have it).
// ---------------------------------------------------------------------------

let _auditInsert: ReturnType<typeof makeSecurityEventInserter> | null = null;
function auditInsert(): ReturnType<typeof makeSecurityEventInserter> {
  if (!_auditInsert) _auditInsert = makeSecurityEventInserter(db());
  return _auditInsert;
}

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
  const database = db();
  const rows = await database
    .select({ orgId: schema.orgUsers.orgId })
    .from(schema.orgUsers)
    .where(eq(schema.orgUsers.userId, userId))
    .orderBy(schema.orgUsers.joinedAt)
    .limit(1);
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

// Production Vercel app domains (per CLAUDE.md interim production URLs).
const PROD_ORIGINS = [
  "https://oxagen-v2-app.vercel.app",
  "https://oxagen-v2-website.vercel.app",
  "https://oxagen-v2-api.vercel.app",
  "https://oxagen-v2-admin.vercel.app",
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
  database: drizzleAdapter(db(), {
    provider: "pg",
    // Better Auth resolves models by name; with usePlural=true the names
    // become "users", "sessions", etc., so the schema keys must match.
    schema: {
      users: schema.users,
      sessions: schema.sessions,
      accounts: schema.accounts,
      verifications: schema.verifications,
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
      // `hd` is the hosted-domain claim Google includes in the ID token for
      // Google Workspace accounts. Capturing it lets us detect Workspace users
      // and prefill organization name on signup (e.g. "acme.com" → "Acme").
      orgDomain: { type: "string", required: false },
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
  },
  socialProviders: {
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            // Explicit minimal scopes — prevents Google Cloud Console pre-authorized
            // scopes from silently expanding the consent screen.
            scope: ["openid", "profile", "email"],
            mapProfileToUser: (profile: { hd?: string }) => ({
              orgDomain: profile.hd ?? null,
            }),
          }
        : undefined,
    github:
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
        : undefined,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },
  advanced: {
    cookiePrefix: "oxagen",
    // Secure cookies in production — EXCEPT under E2E, where Playwright drives
    // a production build (`next start`) over http://localhost. `__Secure-`
    // cookies are never sent over http, so the e2e auth helper could never
    // inject a session. The flag is set only by the Playwright webServer.
    useSecureCookies: env.NODE_ENV === "production" && process.env.E2E_TEST !== "true",
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
    // Account token encryption is only active when AUTH_TOKEN_KMS_KEY_ID is
    // set. In dev/CI without AWS credentials the hooks are omitted so the
    // process boots without throwing on the missing key. In production,
    // AUTH_TOKEN_KMS_KEY_ID is required (enforced by the startup guard above).
    ...(kmsAdapter ? { account: buildAccountTokenHooks(kmsAdapter) } : {}),
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
          recordSecurityEvent(auditInsert(), {
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
          recordSecurityEvent(auditInsert(), {
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
