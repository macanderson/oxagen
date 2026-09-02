import { and, eq } from "drizzle-orm";
import { isDirectRunEntry } from "@oxagen/telemetry";
import { isProductionRuntime } from "@oxagen/config/env";
import { closeDatabase } from "./client";
import { withSystemDb } from "./tenant";
import { deriveNamespace } from "./namespace";
import {
  plans,
  organizations,
  orgUsers,
  users,
  workspaces,
  workspaceUsers,
  agents,
  agentVersions,
} from "./schema/index";

// Seed runs idempotently. Re-running won't duplicate plans, the dev
// org, the dev user, or their memberships — every insert is guarded
// by ON CONFLICT DO NOTHING against a stable unique column, and lookup
// fallbacks fetch existing rows if the conflict fires.

// Only the free tier is seeded statically — it has no paid Stripe price, so a
// placeholder product id is correct here. Paid plans (Pro, Scale, …) and their
// real Stripe product/price ids are created from the single source of truth
// (packages/billing/src/pricing.ts) by `pnpm billing:stripe-sync --apply`.
// Seed must NOT hardcode paid-plan Stripe ids — they drift out of sync with
// Stripe, and seed can't import @oxagen/billing without a database↔billing
// dependency cycle.
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

// The marketplace queries plugin.installed_plugins directly; there is no
// server-side registry cache. Registries are created per org+workspace on demand.

/**
 * Platform-global seed: data every environment (incl. production) must have,
 * with no tenant data. Paid tiers are created from pricing.ts by
 * `pnpm billing:stripe-sync --apply`. Wired into `pnpm db:migrate` so a fresh
 * DB / `pnpm db:reset` always re-seeds it idempotently.
 */
export async function seedPlatform(): Promise<void> {
  // Bootstrap data that must exist before any tenant scope — wrap in
  // withSystemDb so app.rls_bypass='on' is set for the duration. Raw db() would
  // leave the bypass GUC unset; under TENANT_RLS_ENFORCEMENT_ENABLED=true the
  // FORCE RLS policies would then reject every insert and break DB bootstrap.
  await withSystemDb(async (tx) => {
    for (const plan of PLAN_SEEDS) {
      await tx
        .insert(plans)
        .values(plan)
        .onConflictDoNothing({ target: plans.slug });
    }
  });
}

/**
 * Local-dev seed: the `oxagen-dev` org, a dev user, and a Playground workspace.
 * Must NOT run against production — call only from local tooling.
 *
 * The rule is enforced, not merely documented: this file is a direct-run
 * entrypoint (`tsx packages/database/src/seed.ts`), so a shell that still has a
 * production DATABASE_URL exported would otherwise plant a real `oxagen-dev`
 * org and a `dev@oxagen.ai` user in the production tenant table — rows that are
 * then indistinguishable from a customer's. Production migrate calls
 * `seedPlatform()` only (tools/scripts/seed-platform.ts) and never reaches here.
 *
 * @throws in a production runtime, before any write.
 */
export async function seedDev(): Promise<void> {
  if (isProductionRuntime()) {
    throw new Error(
      "[seed] seedDev() seeds local development fixtures (the oxagen-dev org, " +
        "dev@oxagen.ai, and a Playground workspace) and must never run against " +
        "production. Production seeds platform defaults through seedPlatform() " +
        "only. Refusing to seed.",
    );
  }

  // Tenant-root bootstrap (org/workspace/user/agent) must run with RLS bypassed
  // since no tenant scope exists yet — withSystemDb sets app.rls_bypass='on' for
  // the whole transaction. Using raw db() would leave the bypass GUC unset and,
  // under RLS enforcement, every insert into these FORCE RLS tables would be
  // rejected by the policy WITH CHECK predicate.
  await withSystemDb(async (tx) => {
    const orgSlug = "oxagen-dev";
    await tx
      .insert(organizations)
      .values({
        name: "Oxagen Dev",
        slug: orgSlug,
        // Immutable namespace derived from the slug (fixed seed → no collision).
        namespace: deriveNamespace(orgSlug, new Set()),
        planType: "free",
        status: "active",
      })
      .onConflictDoNothing({ target: organizations.slug });
    const orgRow = (
      await tx
        .select()
        .from(organizations)
        .where(eq(organizations.slug, orgSlug))
        .limit(1)
    )[0];
    if (!orgRow) throw new Error("Failed to upsert dev org");

    const userEmail = "dev@oxagen.ai";
    await tx
      .insert(users)
      .values({ email: userEmail, displayName: "Dev User", status: "active" })
      .onConflictDoNothing({ target: users.email });
    const userRow = (
      await tx.select().from(users).where(eq(users.email, userEmail)).limit(1)
    )[0];
    if (!userRow) throw new Error("Failed to upsert dev user");

    const workspaceSlug = "playground";
    await tx
      .insert(workspaces)
      .values({
        orgId: orgRow.id,
        name: "Playground",
        slug: workspaceSlug,
        // Immutable namespace, unique within the org (fixed seed → no collision).
        namespace: deriveNamespace(workspaceSlug, new Set()),
      })
      .onConflictDoNothing({ target: [workspaces.orgId, workspaces.slug] });
    const workspaceRow = (
      await tx
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.orgId, orgRow.id),
            eq(workspaces.slug, workspaceSlug),
          ),
        )
        .limit(1)
    )[0];
    if (!workspaceRow) throw new Error("Failed to upsert dev workspace");

    await tx
      .insert(orgUsers)
      .values({
        orgId: orgRow.id,
        userId: userRow.id,
        role: "owner",
        joinedAt: new Date(),
      })
      .onConflictDoNothing({ target: [orgUsers.orgId, orgUsers.userId] });

    await tx
      .insert(workspaceUsers)
      .values({
        workspaceId: workspaceRow.id,
        userId: userRow.id,
        role: "owner",
        joinedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [workspaceUsers.workspaceId, workspaceUsers.userId],
      });

    // Seed the built-in qa-chat agent for the dev workspace. Inline logic avoids
    // importing @oxagen/handlers (would create a database ↔ handlers dep cycle).
    await tx
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
      await tx
        .select({ id: agents.id, activeVersionId: agents.activeVersionId })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, workspaceRow.id),
            eq(agents.slug, "qa-chat"),
          ),
        )
        .limit(1)
    )[0];
    if (!agentRow) throw new Error("Failed to upsert dev qa-chat agent");

    // Only insert the version and wire activeVersionId when it is missing.
    if (!agentRow.activeVersionId) {
      await tx
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
        await tx
          .select({ id: agentVersions.id })
          .from(agentVersions)
          .where(
            and(
              eq(agentVersions.agentId, agentRow.id),
              eq(agentVersions.version, 1),
            ),
          )
          .limit(1)
      )[0];
      if (!versionRow)
        throw new Error("Failed to upsert dev qa-chat agent version");

      await tx
        .update(agents)
        .set({ activeVersionId: versionRow.id, updatedByUserId: userRow.id })
        .where(eq(agents.id, agentRow.id));
    }
  });
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

// Bundle-safe direct-run guard — see @oxagen/telemetry is-direct-run.ts.
if (isDirectRunEntry(import.meta.url, process.argv[1], "seed")) {
  seed()
    .then(() => closeDatabase())
    .then(() => {
      process.stdout.write("Seed complete\n");
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(
        `Seed failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    });
}
