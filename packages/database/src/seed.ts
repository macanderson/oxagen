import { and, eq } from "drizzle-orm";
import { db, closeDatabase } from "./client.js";
import {
  plans,
  tenants,
  tenantUsers,
  users,
  workspaces,
  workspaceUsers,
} from "./schema/index.js";

// Seed runs idempotently. Re-running won't duplicate plans, the dev
// tenant, the dev user, or their memberships — every insert is guarded
// by ON CONFLICT DO NOTHING against a stable unique column, and lookup
// fallbacks fetch existing rows if the conflict fires.

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
    features: { tools: "basic", agents: 1 },
    isPublic: true,
  },
  {
    name: "Pro",
    slug: "pro",
    tier: "pro",
    stripeProductId: "prod_pro_placeholder",
    stripePriceIdMonthly: "price_pro_monthly_placeholder",
    stripePriceIdAnnual: "price_pro_annual_placeholder",
    monthlyCents: 2000,
    annualCents: 20000,
    includedCreditCents: 500_000,
    includedSeats: 5,
    features: { tools: "all", agents: 25, support: "email" },
    isPublic: true,
  },
  {
    name: "Enterprise",
    slug: "enterprise",
    tier: "enterprise",
    stripeProductId: "prod_enterprise_placeholder",
    stripePriceIdMonthly: "price_enterprise_monthly_placeholder",
    stripePriceIdAnnual: "price_enterprise_annual_placeholder",
    monthlyCents: 10000,
    annualCents: 100000,
    includedCreditCents: 5_000_000,
    includedSeats: 25,
    features: { tools: "all", agents: "unlimited", support: "dedicated", sso: true },
    isPublic: true,
  },
];

export async function seed(): Promise<void> {
  const database = db();

  for (const plan of PLAN_SEEDS) {
    await database.insert(plans).values(plan).onConflictDoNothing({ target: plans.slug });
  }

  const tenantSlug = "oxagen-dev";
  await database
    .insert(tenants)
    .values({ name: "Oxagen Dev", slug: tenantSlug, planType: "free", status: "active" })
    .onConflictDoNothing({ target: tenants.slug });
  const tenantRow = (
    await database.select().from(tenants).where(eq(tenants.slug, tenantSlug)).limit(1)
  )[0];
  if (!tenantRow) throw new Error("Failed to upsert dev tenant");

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
    .values({ tenantId: tenantRow.id, name: "Playground", slug: workspaceSlug })
    .onConflictDoNothing({ target: [workspaces.tenantId, workspaces.slug] });
  const workspaceRow = (
    await database
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.tenantId, tenantRow.id), eq(workspaces.slug, workspaceSlug)))
      .limit(1)
  )[0];
  if (!workspaceRow) throw new Error("Failed to upsert dev workspace");

  await database
    .insert(tenantUsers)
    .values({
      tenantId: tenantRow.id,
      userId: userRow.id,
      role: "owner",
      joinedAt: new Date(),
    })
    .onConflictDoNothing({ target: [tenantUsers.tenantId, tenantUsers.userId] });

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

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  seed()
    .then(() => closeDatabase())
    .then(() => {
      // eslint-disable-next-line no-console
      console.log("Seed complete");
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
