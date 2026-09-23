import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { CREDIT_REASONS } from "./constants";
const mocks = vi.hoisted(() => ({ insert: vi.fn(), failAfterCharge: false }));
vi.mock("@oxagen/telemetry", async (original) => ({
  ...(await original<typeof import("@oxagen/telemetry")>()),
  insertDurableTokenUsage: mocks.insert,
}));
vi.mock("./metering", async (original) => {
  const real = await original<typeof import("./metering")>();
  return {
    ...real,
    chargeUsageCredits: async (
      ...args: Parameters<typeof real.chargeUsageCredits>
    ) => {
      const result = await real.chargeUsageCredits(...args);
      if (mocks.failAfterCharge) throw new Error("injected after debit");
      return result;
    },
  };
});
import {
  admitUsage,
  deliverUsageOutbox,
  finalizeUsage,
  USAGE_OUTBOX_RETENTION_DAYS,
  voidUsage,
} from "./usage-outbox";
const orgId = randomUUID();
const workspaceId = randomUUID();
const scope = <T>(fn: () => T) => runInTenantScope({ orgId, workspaceId }, fn);
const row = {
  org_id: orgId,
  workspace_id: workspaceId,
  execution_step_id: null,
  model: "anthropic/claude-sonnet-5",
  provider: "anthropic" as const,
  input_tokens: 100_100,
  output_tokens: 0,
  cached_tokens: 0,
  cost_usd_micros: 300_300,
  duration_ms: 10,
  surface: "api" as const,
  prompt_hash: "hash",
  created_at: new Date().toISOString(),
};
const charge = {
  orgId,
  reason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
  model: row.model,
  inputTokens: row.input_tokens,
  outputTokens: 0,
  markup: 1,
};
async function state() {
  return withSystemDb(async (tx) => ({
    entries: await tx
      .select()
      .from(schema.usageOutbox)
      .where(eq(schema.usageOutbox.orgId, orgId)),
    ledger: await tx
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.orgId, orgId)),
    balances: await tx
      .select()
      .from(schema.creditBalances)
      .where(eq(schema.creditBalances.orgId, orgId)),
    carry: await tx
      .select({
        carry: schema.orgBillingSettings.meterCarryMicroCreditsByReason,
      })
      .from(schema.orgBillingSettings)
      .where(eq(schema.orgBillingSettings.orgId, orgId)),
    counters: await tx
      .select()
      .from(schema.spendCounters)
      .where(eq(schema.spendCounters.orgId, orgId)),
    lots: await tx
      .select()
      .from(schema.creditLots)
      .where(eq(schema.creditLots.orgId, orgId)),
  }));
}
describe.skipIf(!process.env["DATABASE_URL"])(
  "usage delivery and debit transaction",
  () => {
    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.insert(schema.organizations).values({
          id: orgId,
          name: "Usage outbox witness",
          slug: `usage-${orgId}`,
          namespace: `u${orgId.replaceAll("-", "").slice(0, 5)}`,
          planType: "free",
          status: "active",
        });
        await tx
          .insert(schema.creditBalances)
          .values({ orgId, balanceCents: 100_000n });
        await tx.insert(schema.creditLots).values({
          orgId,
          source: "free_grant",
          originalCents: 100_000n,
          remainingCents: 100_000n,
          grantedAt: new Date(),
          expiresAt: null,
        });
      });
    });
    afterAll(async () => {
      await withSystemDb(async (tx) => {
        for (const table of [
          schema.usageOutbox,
          schema.creditLedger,
          schema.creditLots,
          schema.spendCounters,
          schema.orgBillingSettings,
          schema.creditBalances,
        ])
          await tx.delete(table).where(eq(table.orgId, orgId));
        await tx
          .delete(schema.organizations)
          .where(eq(schema.organizations.id, orgId));
      });
    });
    it("rolls back counter, carry, debit, and finalization together, then retries exactly once", async () => {
      const id = await scope(() => admitUsage(orgId, workspaceId));
      const before = await state();
      mocks.failAfterCharge = true;
      await expect(
        scope(() => finalizeUsage({ id, row, charge })),
      ).rejects.toThrow("injected after debit");
      const rolledBack = await state();
      expect(rolledBack.ledger).toEqual(before.ledger);
      expect(rolledBack.counters).toEqual(before.counters);
      expect(rolledBack.lots).toEqual(before.lots);
      expect(rolledBack.balances).toEqual(before.balances);
      expect(rolledBack.carry).toEqual(before.carry);
      expect(rolledBack.entries[0]?.finalizedAt).toBeNull();
      expect(rolledBack.entries[0]?.payload).toMatchObject(row);
      mocks.failAfterCharge = false;
      await Promise.all([
        scope(() => finalizeUsage({ id, row, charge })),
        scope(() => finalizeUsage({ id, row, charge })),
      ]);
      const committed = await state();
      expect(committed.ledger).toHaveLength(1);
      expect(
        committed.carry[0]?.carry[CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS],
      ).toBeGreaterThan(0);
      expect(committed.balances[0]!.balanceCents).toBe(
        committed.lots[0]!.remainingCents,
      );
      expect(committed.counters[0]?.spentMicros).toBe(300_300n);
      expect(committed.entries[0]?.payload).toMatchObject(row);
      expect(committed.lots[0]!.remainingCents).toBeLessThan(
        before.lots[0]!.remainingCents,
      );
      // A second actual call sharing the same execution step is a second charge.
      const second = await scope(() => admitUsage(orgId, workspaceId));
      await scope(() => finalizeUsage({ id: second, row, charge }));
      expect((await state()).ledger).toHaveLength(2);
    });
    it("retains failed delivery, retries the same identity, and never repeats a debit", async () => {
      mocks.insert.mockRejectedValue(new Error("breaker open"));
      const before = await state();
      const boundary = new Date();
      const failed = await deliverUsageOutbox(100, boundary);
      expect(failed.failed).toBeGreaterThanOrEqual(2);
      expect(
        (await state()).entries.every(
          (entry) => entry.payload !== null && entry.deliveredAt === null,
        ),
      ).toBe(true);
      const attempts = mocks.insert.mock.calls.length;
      await deliverUsageOutbox(100, boundary);
      expect(mocks.insert).toHaveBeenCalledTimes(attempts);
      await withSystemDb((tx) =>
        tx
          .update(schema.usageOutbox)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(schema.usageOutbox.orgId, orgId)),
      );
      mocks.insert.mockResolvedValue(undefined);
      await deliverUsageOutbox();
      const delivered = await state();
      expect(
        delivered.entries.every(
          (entry) => entry.payload === null && entry.deliveredAt !== null,
        ),
      ).toBe(true);
      expect(delivered.ledger).toEqual(before.ledger);
      expect(new Set(mocks.insert.mock.calls.map(([id]) => id)).size).toBe(2);
    });
    it("refuses cross-tenant finalization and exposes stale incomplete admissions", async () => {
      const id = await scope(() => admitUsage(orgId, workspaceId));
      await expect(
        scope(() =>
          finalizeUsage({
            id,
            row: { ...row, workspace_id: randomUUID() },
            charge,
          }),
        ),
      ).rejects.toThrow("scope differs");
      // Two hours old: past the grace period, inside the reporting window.
      await withSystemDb((tx) =>
        tx
          .update(schema.usageOutbox)
          .set({ admittedAt: new Date(Date.now() - 2 * 3_600_000) })
          .where(eq(schema.usageOutbox.id, id)),
      );
      expect((await deliverUsageOutbox()).incomplete).toBeGreaterThan(0);
      const [entry] = await withSystemDb((tx) =>
        tx
          .select()
          .from(schema.usageOutbox)
          .where(eq(schema.usageOutbox.id, id)),
      );
      expect(entry?.finalizedAt).toBeNull();
      expect(entry?.payload).toBeNull();
      // Past the window, the same admission leaves the count. It is still in
      // the table for an audit; it no longer drives the alert.
      await withSystemDb((tx) =>
        tx
          .update(schema.usageOutbox)
          .set({ admittedAt: new Date(Date.now() - 30 * 86_400_000) })
          .where(eq(schema.usageOutbox.id, id)),
      );
      expect((await deliverUsageOutbox()).incomplete).toBe(0);
    });
    it("voids an admission whose provider call reported nothing, and refuses usage after the void", async () => {
      const id = await scope(() => admitUsage(orgId, workspaceId));
      await expect(
        scope(() =>
          voidUsage({
            id,
            orgId,
            workspaceId,
            reason: "provider_call_failed",
          }),
        ),
      ).resolves.toBe(true);
      await withSystemDb((tx) =>
        tx
          .update(schema.usageOutbox)
          .set({ admittedAt: new Date(Date.now() - 2 * 3_600_000) })
          .where(eq(schema.usageOutbox.id, id)),
      );
      const ledgerBefore = (await state()).ledger.length;
      // Closed: not incomplete, not pending, and not open to a late report.
      const sweep = await deliverUsageOutbox();
      expect(sweep.selected).toBe(0);
      await scope(() => finalizeUsage({ id, row, charge }));
      const [entry] = await withSystemDb((tx) =>
        tx
          .select()
          .from(schema.usageOutbox)
          .where(eq(schema.usageOutbox.id, id)),
      );
      expect(entry?.usageComplete).toBe(true);
      expect(entry?.payload).toBeNull();
      expect(entry?.finalizedAt).not.toBeNull();
      expect((await state()).ledger).toHaveLength(ledgerBefore);
      // A second void is a no-op, reported as such.
      await expect(
        scope(() =>
          voidUsage({ id, orgId, workspaceId, reason: "provider_call_failed" }),
        ),
      ).resolves.toBe(false);
    });
    it("does not void an admission that already carries usage", async () => {
      const id = await scope(() => admitUsage(orgId, workspaceId));
      await scope(() => finalizeUsage({ id, row, charge }));
      await expect(
        scope(() =>
          voidUsage({ id, orgId, workspaceId, reason: "provider_call_failed" }),
        ),
      ).resolves.toBe(false);
      const [entry] = await withSystemDb((tx) =>
        tx
          .select()
          .from(schema.usageOutbox)
          .where(eq(schema.usageOutbox.id, id)),
      );
      expect(entry?.payload).toMatchObject(row);
    });
    it("sweeps delivered admissions past the retention window and keeps the rest", async () => {
      const retained = await scope(() => admitUsage(orgId, workspaceId));
      const expired = await scope(() => admitUsage(orgId, workspaceId));
      const dayMs = 86_400_000;
      await withSystemDb((tx) =>
        tx
          .update(schema.usageOutbox)
          .set({ deliveredAt: new Date(), payload: null, charge: null })
          .where(eq(schema.usageOutbox.id, retained)),
      );
      await withSystemDb((tx) =>
        tx
          .update(schema.usageOutbox)
          .set({
            deliveredAt: new Date(
              Date.now() - (USAGE_OUTBOX_RETENTION_DAYS + 1) * dayMs,
            ),
            payload: null,
            charge: null,
          })
          .where(eq(schema.usageOutbox.id, expired)),
      );
      const [privilege] = (await withSystemDb((tx) =>
        tx.execute(
          sql`select has_table_privilege(current_user, 'billing.usage_outbox', 'DELETE') as ok`,
        ),
      )) as unknown as Array<{ ok: boolean }>;
      const result = await deliverUsageOutbox();
      const ids = (await state()).entries.map((entry) => entry.id);
      expect(ids).toContain(retained);
      if (privilege?.ok === true) {
        expect(result.swept).toBeGreaterThanOrEqual(1);
        expect(ids).not.toContain(expired);
      } else {
        // The grant is missing on this database: the pass reports once and
        // deletes nothing rather than failing every minute.
        expect(result.swept).toBe(0);
        expect(ids).toContain(expired);
      }
    });
  },
);
