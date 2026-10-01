// The signup grant against a real Postgres (ADR-NEW, #4886): the unique
// index on gau_signup_grants.org_id refuses a second grant to one
// organisation, and the size a signup receives is the one on the Free plan
// row at that moment. Runs wherever DATABASE_URL points at a migrated
// database. CI's unit job migrates Postgres with Atlas before the suites run;
// a local run without one is skipped, not red. Each case runs in one
// transaction that it rolls back, so the Free row and the org it creates are
// never left changed for another suite.
import { afterAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  schema,
  type Tx,
  withSystemDb,
} from "@oxagen/database";
import { eq } from "drizzle-orm";
import { FREE_PLAN_SLUG } from "./contract-terms";
import { issueSignupGrant } from "./signup-grant";

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
  const slug = `grant-${id.replace(/-/g, "").slice(0, 10)}`;
  await tx.insert(schema.organizations).values({
    id,
    name: `Grant ${slug}`,
    slug,
    // organizations_namespace_check: ^[a-z0-9]{2,6}$, globally unique.
    namespace: crypto.randomUUID().replace(/-/g, "").slice(0, 6),
    planType: "free",
    status: "active",
  });
  return id;
}

describe.skipIf(!enabled)("signup grant against Postgres", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it("issues one grant per organisation and refuses a second", async () => {
    const { first, second, rows } = await rolledBack(async (tx) => {
      const orgId = await newOrg(tx);
      const first = await issueSignupGrant(tx, orgId);
      const second = await issueSignupGrant(tx, orgId);
      const rows = await tx
        .select()
        .from(schema.gauSignupGrants)
        .where(eq(schema.gauSignupGrants.orgId, orgId));
      return { first, second, rows };
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(rows).toHaveLength(1);
  });

  it("gives the next signup the size an operator sets on the Free row", async () => {
    const grant = await rolledBack(async (tx) => {
      await tx
        .update(schema.plans)
        .set({ signupGrantGau: 12_345, signupGrantDays: 7 })
        .where(eq(schema.plans.slug, FREE_PLAN_SLUG));
      const orgId = await newOrg(tx);
      return issueSignupGrant(tx, orgId, new Date("2026-10-01T00:00:00.000Z"));
    });

    expect(grant).toEqual({
      grantedGau: 12_345,
      grantedAt: new Date("2026-10-01T00:00:00.000Z"),
      expiresAt: new Date("2026-10-08T00:00:00.000Z"),
    });
  });
});
