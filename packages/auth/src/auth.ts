import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { loadEnv } from "@oxagen/config/env";

// Better Auth binds to the canonical auth.users row, not a parallel table.
// The Drizzle adapter looks up columns via JS property lookup
// (`schemaModel[fieldName]`), so the fields map must use camelCase Drizzle
// field names — Drizzle handles the camelCase → snake_case translation when
// it emits SQL.
const env = loadEnv();

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
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
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
    useSecureCookies: env.NODE_ENV === "production",
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
});

export type Auth = typeof auth;
export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;
