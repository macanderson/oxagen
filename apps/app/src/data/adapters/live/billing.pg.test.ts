// Contract test against a real Postgres: seeds a throwaway organization with a
// plan, a subscription and two invoices (one issued, one draft), then reads
// them back through the production I/O of the live billing adapter: the real
// get_subscription handler in tenant scope, `billing.plans.tier` and
// `billing.invoices` through withTenantDb. Removes what it wrote.
//
// Opt-in, because unit runs have no database:
//
//   MC_LIVE_PG=1 DATABASE_URL=postgres://oxagen:…@localhost:5433/oxagen \
//     pnpm --filter @oxagen/app exec vitest run src/data/adapters/live/billing.pg.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BillingPlan } from "@/data/contracts";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";

const enabled = process.env.MC_LIVE_PG === "1";

describe.skipIf(!enabled)("live billing adapter against Postgres", async () => {
  const { schema, withSystemDb } = await import("@oxagen/database");
  const { eq, inArray } = await import("drizzle-orm");
  const { runInTenantScope } = await import("@oxagen/tenancy");
  const { billingSubscriptionRead } = await import(
    "@oxagen/oxagen/contracts/billing.subscription.read"
  );
  const { billingSubscriptionReadHandler } = await import(
    "@oxagen/handlers/billing.subscription.read"
  );
  const { createLiveBilling, liveBillingDeps } = await import("./billing");
  const { toInvoiceMapping } = await import("./mappers/billing");

  const tag = Date.now().toString(36).slice(-6);
  const orgId = crypto.randomUUID();
  const otherOrgId = crypto.randomUUID();
  const planId = crypto.randomUUID();
  const planSlug = `mc-live-pg-scale-${tag}`;
  const scope = { orgId, workspaceId: ORG_ONLY_WORKSPACE_ID };
  const userId = crypto.randomUUID();
  const periodStart = new Date("2026-09-01T00:00:00.000Z");
  const periodEnd = new Date("2026-10-01T00:00:00.000Z");

  /** The real handler, as the kernel would run it, parsed by the contract. */
  async function subscriptionAsKernel(s: typeof scope) {
    const raw = await runInTenantScope(s, () =>
      billingSubscriptionReadHandler(
        {},
        {
          orgId: s.orgId,
          workspaceId: s.workspaceId,
          userId,
          apiKeyId: null,
          requestId: crypto.randomUUID(),
          surface: "app",
          messageId: null,
        },
      ),
    );
    return billingSubscriptionRead.output.parse(raw);
  }

  beforeAll(async () => {
    console.info(
      `seeding billing rows into ${String(process.env.DATABASE_URL).replace(/:[^:@/]+@/, ":***@")}`,
    );
    await withSystemDb(async (tx) => {
      for (const [id, n] of [
        [orgId, "a"],
        [otherOrgId, "b"],
      ] as const) {
        await tx.insert(schema.organizations).values({
          id,
          name: `MC live pg ${n}`,
          slug: `mc-live-pg-${n}-${tag}`,
          namespace: `${n}${tag.slice(-5)}`,
          planType: "scale",
          status: "active",
        });
      }
      await tx.insert(schema.plans).values({
        id: planId,
        name: "Scale",
        slug: planSlug,
        tier: "scale",
        stripeProductId: `prod_mclivepg${tag}`,
        monthlyCents: 9_900,
      });
      const [sub] = await tx
        .insert(schema.subscriptions)
        .values({
          orgId,
          planId,
          stripeSubscriptionId: `sub_mclivepg${tag}`,
          stripeCustomerId: `cus_mclivepg${tag}`,
          status: "active",
          billingInterval: "month",
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          seatCount: 25,
        })
        .returning({ id: schema.subscriptions.id });
      await tx.insert(schema.invoices).values([
        {
          orgId,
          subscriptionId: sub?.id ?? null,
          stripeInvoiceId: `in_mclivepg${tag}_paid`,
          number: `MCPG-${tag}-0001`,
          status: "paid",
          amountDueCents: 9_900,
          amountPaidCents: 9_900,
          amountRemainingCents: 0,
          currency: "usd",
          periodStart: new Date("2026-08-01T00:00:00.000Z"),
          periodEnd: periodStart,
        },
        {
          orgId,
          subscriptionId: sub?.id ?? null,
          stripeInvoiceId: `in_mclivepg${tag}_draft`,
          number: null,
          status: "draft",
          amountDueCents: 9_900,
          amountRemainingCents: 9_900,
          currency: "usd",
          periodStart,
          periodEnd,
        },
      ]);
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      const orgs = [orgId, otherOrgId];
      await tx
        .delete(schema.invoices)
        .where(inArray(schema.invoices.orgId, orgs));
      await tx
        .delete(schema.subscriptions)
        .where(inArray(schema.subscriptions.orgId, orgs));
      await tx.delete(schema.plans).where(eq(schema.plans.id, planId));
      await tx
        .delete(schema.organizations)
        .where(inArray(schema.organizations.id, orgs));
    });
  });

  const port = createLiveBilling({
    principal: () => Promise.resolve(userId),
    subscription: ({ scope: s }) => subscriptionAsKernel(s),
    planTier: liveBillingDeps.planTier,
    invoiceRows: liveBillingDeps.invoiceRows,
  });

  it("the seeded subscription reads as the Team plan renewing at period end", async () => {
    const read = await port.plan(scope);
    expect(read).toEqual({
      ok: true,
      value: {
        plan: "team",
        status: "active",
        nextInvoiceOn: "2026-10-01",
        discount: null,
      },
    });
    if (read.ok) expect(BillingPlan.parse(read.value)).toEqual(read.value);
  });

  it("plans.tier is read by the slug get_subscription returns", async () => {
    await expect(liveBillingDeps.planTier(scope, planSlug)).resolves.toBe(
      "scale",
    );
    await expect(
      liveBillingDeps.planTier(scope, `${planSlug}-missing`),
    ).resolves.toBeNull();
  });

  it("reads issued invoice headers only, and parses their recorded columns", async () => {
    const rows = await liveBillingDeps.invoiceRows(scope);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (!row) throw new Error("no invoice row");
    expect(toInvoiceMapping(row).recorded).toEqual({
      number: `MCPG-${tag}-0001`,
      period: "2026-08",
      amount: { micros: "99000000", currency: "USD" },
      status: "paid",
    });
  });

  it("an issued invoice makes the list not backed on G13, never a zero run count", async () => {
    await expect(port.invoices(scope)).resolves.toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M2",
      gap: "G13",
    });
  });

  it("another organization sees neither the subscription nor the invoices", async () => {
    const other = { orgId: otherOrgId, workspaceId: ORG_ONLY_WORKSPACE_ID };
    await expect(liveBillingDeps.invoiceRows(other)).resolves.toEqual([]);
    await expect(port.invoices(other)).resolves.toEqual({
      ok: true,
      value: [],
    });
    await expect(port.plan(other)).resolves.toMatchObject({
      ok: false,
      reason: "not_backed",
    });
  });
});
