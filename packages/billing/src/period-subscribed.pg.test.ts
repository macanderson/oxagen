// readPeriodSubscribed against a real Postgres (ADR-241, signup grant). The
// close job asks it whether a subscription covered an ended bucket, after the
// subscription may already read `canceled` (Codex review on #4936). Runs
// wherever DATABASE_URL points at a migrated, seeded database. CI's unit job
// migrates and seeds Postgres before the suites run; a local run without one
// is skipped, not red. Each case runs in one transaction that it rolls back.
import { afterAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  schema,
  type Tx,
  withSystemDb,
} from "@oxagen/database";
import { eq } from "drizzle-orm";
import { FREE_PLAN_SLUG, readPeriodSubscribed } from "./contract-terms";

const enabled = Boolean(process.env.DATABASE_URL);

class Rollback extends Error {}

/** Run `fn` in a transaction and roll it back, returning what it returned. */
async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await withSystemDb(async (tx) => {
    out = await fn(tx);
    throw new Rollback();
  }).catch((error: unknown) => {
    if (!(error instanceof Rollback)) throw error;
  });
  return out as T;
}

async function newOrg(tx: Tx): Promise<string> {
  const id = crypto.randomUUID();
  const slug = `subd-${id.replace(/-/g, "").slice(0, 10)}`;
  await tx.insert(schema.organizations).values({
    id,
    name: `Subscribed ${slug}`,
    slug,
    // organizations_namespace_check: ^[a-z0-9]{2,6}$, globally unique.
    namespace: crypto.randomUUID().replace(/-/g, "").slice(0, 6),
    planType: "free",
    status: "active",
  });
  return id;
}

const AUGUST = {
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-09-01T00:00:00.000Z"),
};

async function subscribe(
  tx: Tx,
  orgId: string,
  row: {
    status: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    createdAt: Date;
  },
): Promise<void> {
  const plans = await tx
    .select({ id: schema.plans.id })
    .from(schema.plans)
    .where(eq(schema.plans.slug, FREE_PLAN_SLUG))
    .limit(1);
  const planId = plans[0]?.id;
  if (planId === undefined) throw new Error("the Free plan row is not seeded");
  const ref = crypto.randomUUID().replace(/-/g, "").slice(0, 14);
  await tx.insert(schema.subscriptions).values({
    orgId,
    planId,
    stripeSubscriptionId: `sub_${ref}`,
    stripeCustomerId: `cus_${ref}`,
    billingInterval: "month",
    ...row,
  });
}

describe.skipIf(!enabled)("readPeriodSubscribed against Postgres", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it("counts a subscription canceled at the end of the ended month", async () => {
    const covered = await rolledBack(async (tx) => {
      const orgId = await newOrg(tx);
      await subscribe(tx, orgId, {
        status: "canceled",
        currentPeriodStart: AUGUST.start,
        currentPeriodEnd: AUGUST.end,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      });
      return readPeriodSubscribed(tx, orgId, AUGUST);
    });
    expect(covered).toBe(true);
  });

  it("counts an active subscription that renewed past the ended month", async () => {
    const covered = await rolledBack(async (tx) => {
      const orgId = await newOrg(tx);
      await subscribe(tx, orgId, {
        status: "active",
        currentPeriodStart: AUGUST.end,
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      });
      return readPeriodSubscribed(tx, orgId, AUGUST);
    });
    expect(covered).toBe(true);
  });

  it.each([
    [
      "a subscription canceled before the month ended",
      {
        status: "canceled",
        currentPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
        currentPeriodEnd: AUGUST.start,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ],
    [
      "a subscription that started after the month ended",
      {
        status: "active",
        currentPeriodStart: new Date("2026-09-05T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-05T00:00:00.000Z"),
        createdAt: new Date("2026-09-05T00:00:00.000Z"),
      },
    ],
    [
      "a subscription that never took a first payment",
      {
        status: "incomplete_expired",
        currentPeriodStart: AUGUST.start,
        currentPeriodEnd: AUGUST.end,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ],
  ] as const)("does not count %s (negative)", async (_what, row) => {
    const covered = await rolledBack(async (tx) => {
      const orgId = await newOrg(tx);
      await subscribe(tx, orgId, row);
      return readPeriodSubscribed(tx, orgId, AUGUST);
    });
    expect(covered).toBe(false);
  });
});
