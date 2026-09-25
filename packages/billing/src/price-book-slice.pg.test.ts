/**
 * The slice read against real Postgres (#4202). The unit tests in
 * price-book.test.ts evaluate the filter in memory; this file proves the
 * statement itself: the name list binds as `IN (...)` on `model` and as a
 * `text[]` overlap on `model_aliases`, and the span keeps only rows that are
 * in force at some instant inside it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  loadPriceBookSlice,
  loadPriceBookSliceInTenantScope,
} from "./price-book";

const orgId = randomUUID();
const workspaceId = randomUUID();
// No separators inside the name, so its only claimable prefixes are the ones
// the test means.
const model = `slice${orgId.replaceAll("-", "")}`;
const slice = {
  orgId,
  // A stamped, creator-prefixed id: the family `model` prices it.
  models: [`vendor/${model}-20260901`],
  from: new Date("2026-09-20T00:00:00.000Z"),
  to: new Date("2026-09-21T00:00:00.000Z"),
};

function row(id: string, over: Partial<typeof schema.priceEntries.$inferInsert>) {
  return {
    id,
    orgId,
    provider: "slice-test",
    model,
    modelAliases: [] as string[],
    tokenClass: "input_uncached",
    unit: "token",
    microsPerMillion: 1_000_000n,
    effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
    effectiveTo: null,
    source: "negotiated",
    ...over,
  };
}

const family = randomUUID();
const byAlias = randomUUID();
const otherModel = randomUUID();
const later = randomUUID();

describe.skipIf(!process.env["DATABASE_URL"])(
  "loading a slice of the price book from Postgres",
  () => {
    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.insert(schema.organizations).values({
          id: orgId,
          name: "Price book slice witness",
          slug: `slice-${orgId}`,
          namespace: `s${orgId.replaceAll("-", "").slice(0, 5)}`,
          planType: "free",
          status: "active",
        });
        await tx.insert(schema.priceEntries).values([
          row(family, {}),
          row(byAlias, { model: `other${model}`, modelAliases: [model] }),
          row(otherModel, { model: `${model}-mini` }),
          row(later, {
            tokenClass: "output",
            effectiveFrom: new Date("2026-10-01T00:00:00.000Z"),
          }),
        ]);
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.priceEntries)
          .where(eq(schema.priceEntries.orgId, orgId));
        await tx
          .delete(schema.organizations)
          .where(eq(schema.organizations.id, orgId));
      });
    });

    it("returns the family row and the alias row, and nothing else of this organization's", async () => {
      const rows = await loadPriceBookSlice(slice);
      const own = rows.filter((r) => r.orgId === orgId).map((r) => r.id);
      expect(own.sort()).toEqual([family, byAlias].sort());
    });

    it("answers the same inside the organization's tenant scope", async () => {
      const rows = await runInTenantScope({ orgId, workspaceId }, () =>
        loadPriceBookSliceInTenantScope(slice),
      );
      const own = rows.filter((r) => r.orgId === orgId).map((r) => r.id);
      expect(own.sort()).toEqual([family, byAlias].sort());
    });
  },
);
