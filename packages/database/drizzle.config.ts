import { defineConfig } from "drizzle-kit";

// Hand-edited SQL migrations per spec §10. drizzle-kit generates the
// initial draft; reviewers tighten constraints and indexes before merge.
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://oxagen:oxagen@localhost:5432/oxagen",
  },
  schemaFilter: [
    "auth",
    "org",
    "workspace",
    "agent",
    "workflow",
    "chat",
    "content",
    "billing",
    "security",
    "ingestion",
    "mcp",
    "plugin",
    "notification",
  ],
  verbose: true,
  strict: true,
});
