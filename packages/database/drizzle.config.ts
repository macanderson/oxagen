import { defineConfig } from "drizzle-kit";

// Hand-edited SQL migrations per spec §10. drizzle-kit generates the
// initial draft; reviewers tighten constraints and indexes before merge.
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // The local Docker Postgres listens on 5433, NOT the default 5432 — 5432 is
    // left to whatever system Postgres the developer already runs, so falling
    // back to it would silently point drizzle-kit at the wrong database.
    url:
      process.env.DATABASE_URL ??
      "postgres://oxagen:oxagen@localhost:5433/oxagen",
  },
  // Must list EVERY pgSchema declared in src/schema/_schemas.ts. A schema
  // missing here is invisible to drizzle-kit introspect/push, so its tables
  // read as absent and a diff proposes dropping them.
  schemaFilter: [
    "auth",
    "org",
    "workspace",
    "iam",
    "agent",
    "workflow",
    "chat",
    "content",
    "billing",
    "security",
    "ingestion",
    "evidence",
    "mcp",
    "plugin",
    "notification",
    "privacy",
    "schema_registry",
    "environments",
    "ai",
    "eval",
    "cms",
    "ratelimit",
  ],
  verbose: true,
  strict: true,
});
