import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { schema, withSystemDb, type Tx } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";

const control = vi.hoisted(() => ({
  afterInsert: null as (() => Promise<void>) | null,
}));
vi.mock("@oxagen/database", async (original) => {
  const real = await original<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: <T>(callback: (tx: Tx) => Promise<T>) =>
      real.withTenantDb((tx) =>
        callback(
          new Proxy(tx, {
            get(target, property) {
              if (property === "execute")
                return async (query: Parameters<Tx["execute"]>[0]) => {
                  const result = await target.execute(query);
                  const text =
                    query instanceof SQL
                      ? new PgDialect().sqlToQuery(query).sql
                      : "";
                  if (
                    text.includes("INSERT INTO") &&
                    text.includes("price_entries")
                  )
                    await control.afterInsert?.();
                  return result;
                };
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
  };
});
import { loadPriceBook, setNegotiatedPriceCard } from "./price-book";
import { rollupRun, ZERO_TOKENS, type RunMeta } from "./cost-rollup";

const orgId = randomUUID();
const workspaceId = randomUUID();
const provider = "card-test";
const model = `card-${orgId}`;
const at = new Date("2026-09-20T12:00:00.000Z");
const scope = <T>(fn: () => T) => runInTenantScope({ orgId, workspaceId }, fn);
const base = { orgId, provider, model };
const meta: RunMeta = {
  runId: `tse_${orgId}`,
  runSource: "tacho",
  orgId,
  workspaceId,
  operatorPrincipalId: null,
  operatorKey: null,
  agentPrincipalId: null,
  agentKey: null,
  taskRef: null,
  costCenter: null,
  startedAt: at,
  sealedAt: at,
  turns: 1,
  retries: 0,
  enforcementTier: "observe",
  replayGrade: "inspect",
};
async function sealedCost() {
  return rollupRun({
    meta,
    book: await loadPriceBook({ orgId }),
    toolCalls: [],
    modelCalls: [
      {
        at,
        provider,
        model,
        tokens: {
          ...ZERO_TOKENS,
          input_uncached: 1_000_000,
          output: 1_000_000,
        },
        reportedCostMicros: null,
        basis: "gateway_observed",
      },
    ],
  }).costMicros;
}
const replacement = () =>
  scope(() =>
    setNegotiatedPriceCard({
      ...base,
      now: at,
      effectiveFrom: at,
      rates: [
        { tokenClass: "input_uncached", microsPerMillion: 2_000_000n },
        { tokenClass: "output", microsPerMillion: 4_000_000n },
      ],
    }),
  );

describe.skipIf(!process.env["DATABASE_URL"])(
  "atomic negotiated card in Postgres",
  () => {
    beforeAll(async () => {
      await withSystemDb((tx) =>
        tx.insert(schema.organizations).values({
          id: orgId,
          name: "Atomic card witness",
          slug: `card-${orgId}`,
          namespace: `c${orgId.replaceAll("-", "").slice(0, 5)}`,
          planType: "free",
          status: "active",
        }),
      );
      await scope(() =>
        setNegotiatedPriceCard({
          ...base,
          now: new Date("2026-01-01T00:00:00Z"),
          rates: [
            { tokenClass: "input_uncached", microsPerMillion: 10_000_000n },
            { tokenClass: "output", microsPerMillion: 20_000_000n },
          ],
        }),
      );
    });
    afterAll(async () => {
      control.afterInsert = null;
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.priceEntries)
          .where(eq(schema.priceEntries.orgId, orgId));
        await tx
          .delete(schema.organizations)
          .where(eq(schema.organizations.id, orgId));
      });
    });
    it("rolls back the first class if a later step fails", async () => {
      control.afterInsert = async () => {
        throw new Error("injected after first write");
      };
      await expect(replacement()).rejects.toThrow("injected after first write");
      control.afterInsert = null;
      expect(await sealedCost()).toBe(30_000_000n);
      expect(
        (await loadPriceBook({ orgId })).filter((row) => row.orgId === orgId),
      ).toHaveLength(2);
    });
    it("a run sealing between class writes sees the old card, then the new card after commit", async () => {
      let reached!: () => void;
      let release!: () => void;
      const firstWritten = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      control.afterInsert = async () => {
        control.afterInsert = null;
        reached();
        await resume;
      };
      const write = replacement();
      try {
        await Promise.race([firstWritten, write]);
        expect(await sealedCost()).toBe(30_000_000n);
      } finally {
        release();
      }
      const rows = await write;
      expect(rows.map((row) => row.entry.effectiveFrom.toISOString())).toEqual([
        at.toISOString(),
        at.toISOString(),
      ]);
      expect(await sealedCost()).toBe(6_000_000n);
    });
  },
);
