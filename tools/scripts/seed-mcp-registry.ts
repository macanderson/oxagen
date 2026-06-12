#!/usr/bin/env tsx
/**
 * Seed the default MCP server registry.
 *
 * The official MCP registry at https://registry.modelcontextprotocol.io/v0.1/servers
 * is available to all organizations by default. Organizations can also add custom registries.
 */

import postgres from "postgres";
import { formatError } from "./lib/format-error";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL not set");
  process.exit(1);
}

async function seedMcpRegistry(): Promise<void> {
  const sql = postgres(DATABASE_URL!);

  try {
    console.log("🌱 Seeding MCP server registry...");

    // Insert the official MCP registry as a global/default seed
    await sql`
      INSERT INTO mcp.registries (
        id,
        public_id,
        created_at,
        updated_at,
        name,
        base_url,
        enabled,
        is_default_seed
      )
      VALUES (
        gen_random_uuid(),
        public.citext(gen_random_uuid()::text),
        now(),
        now(),
        'Official MCP Registry',
        'https://registry.modelcontextprotocol.io/v0.1/servers',
        true,
        true
      )
      ON CONFLICT DO NOTHING
    `;

    console.log("✅ MCP registry seeded successfully");
    await sql.end();
  } catch (err) {
    console.error("❌ Error seeding MCP registry:", formatError(err));
    process.exit(1);
  }
}

seedMcpRegistry();
