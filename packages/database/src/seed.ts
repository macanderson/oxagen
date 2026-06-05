import { and, eq } from "drizzle-orm";
import { db, closeDatabase } from "./client";
import {
  plans,
  organizations,
  orgUsers,
  users,
  workspaces,
  workspaceUsers,
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

/**
 * Platform-global seed: data every environment (incl. production) must have,
 * with no tenant data. Currently the Free plan — paid tiers are created from
 * pricing.ts by `pnpm billing:stripe-sync --apply`. Wired into `pnpm db:migrate`
 * so a fresh DB / `pnpm db:reset` always re-seeds it idempotently.
 */
export async function seedPlatform(): Promise<void> {
  const database = db();
  for (const plan of PLAN_SEEDS) {
    await database.insert(plans).values(plan).onConflictDoNothing({ target: plans.slug });
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
