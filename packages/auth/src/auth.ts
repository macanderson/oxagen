import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { makeSecurityEventInserter } from "@oxagen/database/security";
import { requireEnv } from "@oxagen/config/env";
import { recordSecurityEvent } from "@oxagen/telemetry";

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
  // Security audit hooks — emit auth.* events into security.security_events.
  //
  // WIRED:
  //   session.create.after  → auth.sign_in
  //   session.delete.after  → auth.sign_out
  //
  // FLAGGED for follow-up (OXA-1422):
  //   (1) Session expiry (TTL-based invalidation) does NOT trigger
  //       session.delete.after. A sweep job must retroactively emit
  //       auth.sign_out events for expired sessions if that coverage is
  //       required for SOC2 evidence.
  //   (2) Multi-org users: sign-in/out events are emitted for the user's
  //       oldest org membership only. Fix: add org_id to the session model
  //       (populated during workspace selection) and read it here instead of
  //       calling resolveFirstOrgId.
  //   (3) Failed sign-in (wrong password, unknown email): better-auth does not
  //       expose a databaseHooks seam for failed sign-in attempts because no
  //       DB write occurs. The auth.sign_in_failed event type is reserved;
  //       it can be emitted from the API/MCP sign-in route handler by catching
  //       the betterAuth error response before returning it to the client.
  // ---------------------------------------------------------------------------
  databaseHooks: {
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
