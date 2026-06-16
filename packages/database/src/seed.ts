import { and, eq, isNull } from "drizzle-orm";
import { db, closeDatabase } from "./client";
import {
  plans,
  organizations,
  orgUsers,
  users,
  workspaces,
  workspaceUsers,
  agents,
  agentVersions,
  mcpRegistries,
  mcpCatalogServers,
} from "./schema/index";

// Seed runs idempotently. Re-running won't duplicate plans, the dev
// org, the dev user, or their memberships — every insert is guarded
// by ON CONFLICT DO NOTHING against a stable unique column, and lookup
// fallbacks fetch existing rows if the conflict fires.

// Only the free tier is seeded statically — it has no paid Stripe price, so a
// placeholder product id is honest here. Paid plans (Pro, Scale, …) and their
// real Stripe product/price ids are created from the single source of truth
// (packages/billing/src/pricing.ts) by `pnpm billing:stripe-sync --apply`.
// Seed must NOT hardcode paid-plan Stripe ids — that's what drifted before, and
// seed can't import @oxagen/billing without a database↔billing dependency cycle.
const PLAN_SEEDS = [
  {
    name: "Free",
    slug: "free",
    tier: "free",
    stripeProductId: "prod_free_placeholder",
    stripePriceIdMonthly: "price_free_monthly_placeholder",
    stripePriceIdAnnual: null,
    monthlyCents: 0,
    annualCents: null,
    includedCreditCents: 0,
    includedSeats: 1,
    // Display-only bullets in the PlanFeatures `{ list }` shape the billing UI
    // reads (see @oxagen/billing). Free is filtered out of the upgrade grid by
    // the source-of-truth slug allowlist, so these are not normally rendered.
    features: { list: ["1 agent", "Community support"] },
    isPublic: true,
  },
];

// ── MCP marketplace seed ─────────────────────────────────────────────────────
// The global "Official MCP Registry" (org_id NULL ⇒ visible to every org) and a
// curated set of real, well-known MCP servers. Seeding both in seedPlatform()
// guarantees that EVERY environment (incl. prod via `pnpm db:migrate`) has a
// populated, browse-only marketplace the moment a customer signs up — no waiting
// on a live network sync or the 6-hour catalog cron.
//
// Browse-only: these are catalog_servers rows only. We deliberately create NO
// plugin.org_listings — the rows are browsable, not installed.

// Source of truth for the global registry. Must match tools/scripts/seed-mcp-registry.ts.
export const OFFICIAL_MCP_REGISTRY = {
  name: "Official MCP Registry",
  baseUrl: "https://registry.modelcontextprotocol.io/v0.1/servers",
} as const;

/**
 * Curated catalog of real, canonical MCP servers from the official
 * modelcontextprotocol servers list. These are seed rows so the marketplace is
 * never empty; a live registry sync later upserts richer metadata ON TOP of
 * these, keyed by (registry_id, name, version) — the same unique index used by
 * onConflictDoNothing below, so a sync never duplicates a seeded row.
 *
 * Classification (see packages/handlers/src/plugin.catalog.browse.ts): a row is
 * "mcp_server" UNLESS its categories contain 'integration' or 'content_tool'.
 * Every category below is a functional tag (developer-tools / search /
 * productivity / database / observability) so all rows classify as mcp_server.
 *
 * authKind: "none" for local stdio tools that need no credentials;
 *           "oauth"  for hosted services behind OAuth (github/google-drive/slack);
 *           "secret" for services configured with a static secret/DSN (postgres/sentry).
 */
const MCP_CATALOG_SEEDS: ReadonlyArray<{
  name: string;
  title: string;
  description: string;
  authKind: "none" | "oauth" | "secret";
  transportTypes: string[];
  categories: string[];
}> = [
  {
    name: "io.github.modelcontextprotocol/filesystem",
    title: "Filesystem",
    description: "Secure, configurable file system access for reading, writing, and searching local files.",
    authKind: "none",
    transportTypes: ["stdio"],
    categories: ["developer-tools"],
  },
  {
    name: "io.github.modelcontextprotocol/fetch",
    title: "Fetch",
    description: "Fetch and convert web content to markdown for efficient LLM consumption.",
    authKind: "none",
    transportTypes: ["stdio"],
    categories: ["search"],
  },
  {
    name: "io.github.modelcontextprotocol/git",
    title: "Git",
    description: "Read, search, and manipulate Git repositories — diff, log, blame, and commit inspection.",
    authKind: "none",
    transportTypes: ["stdio"],
    categories: ["developer-tools"],
  },
  {
    name: "io.github.modelcontextprotocol/memory",
    title: "Memory",
    description: "A persistent knowledge-graph memory store for long-running agent context.",
    authKind: "none",
    transportTypes: ["stdio"],
    categories: ["productivity"],
  },
  {
    name: "io.github.modelcontextprotocol/time",
    title: "Time",
    description: "Time and timezone conversion utilities for date-aware agents.",
    authKind: "none",
    transportTypes: ["stdio"],
    categories: ["productivity"],
  },
  {
    name: "io.github.modelcontextprotocol/sqlite",
    title: "SQLite",
    description: "Query and inspect SQLite databases with read and write tool support.",
    authKind: "none",
    transportTypes: ["stdio"],
    categories: ["database"],
  },
  {
    name: "io.github.modelcontextprotocol/postgres",
    title: "PostgreSQL",
    description: "Read-only SQL access and schema inspection for PostgreSQL databases.",
    authKind: "secret",
    transportTypes: ["stdio"],
    categories: ["database"],
  },
  {
    name: "io.github.modelcontextprotocol/github",
    title: "GitHub",
    description: "Manage repositories, issues, and pull requests through the GitHub API.",
    authKind: "oauth",
    transportTypes: ["stdio", "streamable-http"],
    categories: ["developer-tools"],
  },
  {
    name: "io.github.modelcontextprotocol/google-drive",
    title: "Google Drive",
    description: "Search and read files from Google Drive with scoped access.",
    authKind: "oauth",
    transportTypes: ["stdio"],
    categories: ["productivity"],
  },
  {
    name: "io.github.modelcontextprotocol/slack",
    title: "Slack",
    description: "Read channels and post messages to Slack workspaces.",
    authKind: "oauth",
    transportTypes: ["stdio"],
    categories: ["productivity"],
  },
  {
    name: "io.github.modelcontextprotocol/sentry",
    title: "Sentry",
    description: "Retrieve and analyze error reports and issues from Sentry projects.",
    authKind: "secret",
    transportTypes: ["stdio", "streamable-http"],
    categories: ["observability"],
  },
];

// Exported for tests: the curated catalog seed shape (no DB required).
export const MCP_CATALOG_SEED_DATA = MCP_CATALOG_SEEDS;

/**
 * Ensure the global "Official MCP Registry" row exists (org_id NULL,
 * is_default_seed=true, enabled=true). The unique constraint on (org_id,
 * base_url) is a COALESCE-on-org_id index that Drizzle's onConflict can't
 * target, so we guard with a select-then-insert on the default-seed row.
 * Returns the registry id.
 */
async function ensureOfficialMcpRegistry(database: ReturnType<typeof db>): Promise<string> {
  const existing = (
    await database
      .select({ id: mcpRegistries.id })
      .from(mcpRegistries)
      .where(
        and(
          isNull(mcpRegistries.orgId),
          eq(mcpRegistries.isDefaultSeed, true),
          eq(mcpRegistries.baseUrl, OFFICIAL_MCP_REGISTRY.baseUrl),
        ),
      )
      .limit(1)
  )[0];
  if (existing) return existing.id;

  const inserted = (
    await database
      .insert(mcpRegistries)
      .values({
        orgId: null,
        name: OFFICIAL_MCP_REGISTRY.name,
        baseUrl: OFFICIAL_MCP_REGISTRY.baseUrl,
        enabled: true,
        isDefaultSeed: true,
      })
      .returning({ id: mcpRegistries.id })
  )[0];
  if (!inserted) throw new Error("Failed to upsert Official MCP Registry");
  return inserted.id;
}

/**
 * Platform-global seed: data every environment (incl. production) must have,
 * with no tenant data. The Free plan, the global Official MCP Registry, and a
 * curated, browse-only MCP marketplace catalog. Paid tiers are created from
 * pricing.ts by `pnpm billing:stripe-sync --apply`. Wired into `pnpm db:migrate`
 * so a fresh DB / `pnpm db:reset` always re-seeds it idempotently.
 */
export async function seedPlatform(): Promise<void> {
  const database = db();
  for (const plan of PLAN_SEEDS) {
    await database.insert(plans).values(plan).onConflictDoNothing({ target: plans.slug });
  }

  // Global MCP registry + curated browse-only marketplace catalog.
  const registryId = await ensureOfficialMcpRegistry(database);
  const now = new Date();
  for (const server of MCP_CATALOG_SEEDS) {
    await database
      .insert(mcpCatalogServers)
      .values({
        registryId,
        name: server.name,
        version: "1.0.0",
        isLatest: true,
        title: server.title,
        description: server.description,
        authKind: server.authKind,
        transportTypes: server.transportTypes,
        categories: server.categories,
        status: "active",
        publishedAt: now,
      })
      // Idempotent against the (registry_id, name, version) unique index.
      .onConflictDoNothing({
        target: [mcpCatalogServers.registryId, mcpCatalogServers.name, mcpCatalogServers.version],
      });
  }
}

/**
 * Local-dev seed: the `oxagen-dev` org, a dev user, and a Playground workspace.
 * Must NOT run against production — call only from local tooling.
 */
export async function seedDev(): Promise<void> {
  const database = db();

  const orgSlug = "oxagen-dev";
  await database
    .insert(organizations)
    .values({ name: "Oxagen Dev", slug: orgSlug, planType: "free", status: "active" })
    .onConflictDoNothing({ target: organizations.slug });
  const orgRow = (
    await database.select().from(organizations).where(eq(organizations.slug, orgSlug)).limit(1)
  )[0];
  if (!orgRow) throw new Error("Failed to upsert dev org");

  const userEmail = "dev@oxagen.ai";
  await database
    .insert(users)
    .values({ email: userEmail, displayName: "Dev User", status: "active" })
    .onConflictDoNothing({ target: users.email });
  const userRow = (
    await database.select().from(users).where(eq(users.email, userEmail)).limit(1)
  )[0];
  if (!userRow) throw new Error("Failed to upsert dev user");

  const workspaceSlug = "playground";
  await database
    .insert(workspaces)
    .values({ orgId: orgRow.id, name: "Playground", slug: workspaceSlug })
    .onConflictDoNothing({ target: [workspaces.orgId, workspaces.slug] });
  const workspaceRow = (
    await database
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.orgId, orgRow.id), eq(workspaces.slug, workspaceSlug)))
      .limit(1)
  )[0];
  if (!workspaceRow) throw new Error("Failed to upsert dev workspace");

  await database
    .insert(orgUsers)
    .values({
      orgId: orgRow.id,
      userId: userRow.id,
      role: "owner",
      joinedAt: new Date(),
    })
    .onConflictDoNothing({ target: [orgUsers.orgId, orgUsers.userId] });

  await database
    .insert(workspaceUsers)
    .values({
      workspaceId: workspaceRow.id,
      userId: userRow.id,
      role: "owner",
      joinedAt: new Date(),
    })
    .onConflictDoNothing({ target: [workspaceUsers.workspaceId, workspaceUsers.userId] });

  // Seed the built-in qa-chat agent for the dev workspace. Inline logic avoids
  // importing @oxagen/handlers (would create a database ↔ handlers dep cycle).
  await database
    .insert(agents)
    .values({
      workspaceId: workspaceRow.id,
      orgId: orgRow.id,
      slug: "qa-chat",
      name: "QA Chat Agent",
      agentType: "interactive_chat",
      status: "active",
      createdByUserId: userRow.id,
      updatedByUserId: userRow.id,
    })
    .onConflictDoNothing();

  const agentRow = (
    await database
      .select({ id: agents.id, activeVersionId: agents.activeVersionId })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceRow.id), eq(agents.slug, "qa-chat")))
      .limit(1)
  )[0];
  if (!agentRow) throw new Error("Failed to upsert dev qa-chat agent");

  // Only insert the version and wire activeVersionId when it is missing.
  if (!agentRow.activeVersionId) {
    await database
      .insert(agentVersions)
      .values({
        agentId: agentRow.id,
        version: 1,
        isPublished: true,
        checksum: null,
        config: {},
        createdByUserId: userRow.id,
      })
      .onConflictDoNothing();

    const versionRow = (
      await database
        .select({ id: agentVersions.id })
        .from(agentVersions)
        .where(and(eq(agentVersions.agentId, agentRow.id), eq(agentVersions.version, 1)))
        .limit(1)
    )[0];
    if (!versionRow) throw new Error("Failed to upsert dev qa-chat agent version");

    await database
      .update(agents)
      .set({ activeVersionId: versionRow.id, updatedByUserId: userRow.id })
      .where(eq(agents.id, agentRow.id));
  }
}

/**
 * Full local seed: platform defaults + the dev org/user/workspace. Direct-run
 * entrypoint (`tsx packages/database/src/seed.ts`). Production migrate calls
 * only `seedPlatform()` — never the dev data.
 */
export async function seed(): Promise<void> {
  await seedPlatform();
  await seedDev();
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  seed()
    .then(() => closeDatabase())
    .then(() => {
      process.stdout.write("Seed complete\n");
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`Seed failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    });
}
