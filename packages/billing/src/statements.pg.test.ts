// A billing statement against a real Postgres (ADR-165). The unit tests in
// statements.test.ts check the arithmetic over fixed reads; this file checks
// the reads themselves: the ledger aggregates, the bucket subqueries, the
// invoice and settlement joins, the credit roll-forward, the labels, and the
// keyset paging of the CSV line items, with a second organization's rows in
// the same tables that must never appear.
//
// Runs wherever DATABASE_URL points at a migrated, seeded database: CI's
// `test` job migrates Postgres with Atlas and seeds the Free plan before the
// suites run. A local run without one is skipped, not red. Every row it
// writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { billingStatementSchema } from "@oxagen/oxagen/contracts/billing.statement.get";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/types";
import { runInTenantScope } from "@oxagen/tenancy";
import { inArray } from "drizzle-orm";
import { debitWithLedger, governedActionEntry } from "./gau-ledger";
import {
  buildBillingStatement,
  readStatementLineItems,
} from "./statement-reads";
import { resolveStatementPeriod } from "./statements";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("billing statement against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const orgId = crypto.randomUUID();
  const otherOrgId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  let agentPublicId = "";

  const TERMS = {
    currency: "usd",
    ratePerGauMicros: 4_500n,
    blockSizeGau: 10_000,
    includedGauPerMonth: 5,
  };
  const SEPT = {
    start: new Date("2026-09-01T00:00:00.000Z"),
    end: new Date("2026-10-01T00:00:00.000Z"),
  };
  const OCT = {
    start: new Date("2026-10-01T00:00:00.000Z"),
    end: new Date("2026-11-01T00:00:00.000Z"),
  };
  const NOW = new Date("2026-11-02T00:00:00.000Z");
  const period = resolveStatementPeriod(
    { kind: "month", anchor: "2026-09-15" },
    NOW,
  );
  const inScope = <T>(fn: () => Promise<T>) =>
    runInTenantScope({ orgId, workspaceId: ORG_ONLY_WORKSPACE_ID }, fn);

  function entry(
    key: string,
    units: number,
    extra: Partial<Parameters<typeof governedActionEntry>[0]> = {},
  ) {
    return governedActionEntry({
      idempotencyKey: `stmt-${tag}-${key}`,
      source: "kernel",
      units,
      occurredAt: new Date("2026-09-02T09:00:00.000Z"),
      capability: "send_message",
      ...extra,
    });
  }

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      for (const [id, slug] of [
        [orgId, `stmt-${tag}`],
        [otherOrgId, `stmt-${tag}-x`],
      ] as const) {
        await tx.insert(schema.organizations).values({
          id,
          name: `Statement ${slug}`,
          slug,
          namespace: crypto.randomUUID().replace(/-/g, "").slice(0, 6),
          planType: "enterprise",
          status: "active",
        });
      }
      await tx.insert(schema.workspaces).values({
        id: workspaceId,
        orgId,
        name: "Payments",
        slug: `pay-${tag}`,
        namespace: crypto.randomUUID().replace(/-/g, "").slice(0, 6),
      });
      await tx.insert(schema.users).values({
        id: userId,
        email: `dana-${tag}@example.com`,
        displayName: "Dana Ops",
        status: "active",
      });
      const [agent] = await tx
        .insert(schema.agents)
        .values({
          orgId,
          workspaceId,
          slug: `release-${tag}`,
          name: "Release bot",
          agentType: "custom",
        })
        .returning({ publicId: schema.agents.publicId });
      agentPublicId = agent!.publicId;
      await tx.insert(schema.contractTerms).values({
        orgId,
        agreementRef: `MSA-${tag}`,
        currency: "usd",
        ratePerGauMicros: 4_500n,
        blockSizeGau: 10_000,
        includedGauPerMonth: 5,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      });
    });

    // Three September debits, one October debit, and another org's September.
    const septBucket = await withSystemDb(async (tx) => {
      await debitWithLedger(tx, orgId, {
        period: SEPT,
        terms: TERMS,
        billedAt: new Date("2026-09-02T09:00:01.000Z"),
        entries: [
          entry("a", 2, {
            workspaceId,
            agentId: agentPublicId,
            operatorUserId: userId,
            runId: "run_a",
          }),
          entry("b", 1, {
            workspaceId,
            agentId: agentPublicId,
            operatorUserId: userId,
          }),
        ],
      });
      await debitWithLedger(tx, orgId, {
        period: SEPT,
        terms: TERMS,
        billedAt: new Date("2026-09-02T09:00:01.000Z"),
        // Same billed instant: the keyset must still page by id.
        entries: [
          entry("c", 1, {
            source: "tacho",
            capability: null,
            toolName: "Bash",
            harness: "claude-code",
            sessionId: "s1",
            toolCallId: "toolu_1",
          }),
        ],
      });
      const r = await debitWithLedger(tx, orgId, {
        period: SEPT,
        terms: TERMS,
        billedAt: new Date("2026-09-30T23:59:59.999Z"),
        entries: [entry("d", 3, { operatorUserId: userId })],
      });
      await debitWithLedger(tx, orgId, {
        period: OCT,
        terms: TERMS,
        billedAt: new Date("2026-10-01T00:00:00.000Z"),
        entries: [entry("e", 5)],
      });
      await debitWithLedger(tx, otherOrgId, {
        period: SEPT,
        terms: TERMS,
        billedAt: new Date("2026-09-10T00:00:00.000Z"),
        entries: [entry("x", 50)],
      });
      return r.bucket;
    });

    await withSystemDb(async (tx) => {
      await tx.insert(schema.gauSettlements).values({
        orgId,
        bucketId: septBucket.id,
        kind: "period_close",
        seq: 0,
        quantityGau: 2,
        ratePerGauMicros: 4_500n,
        currency: "usd",
        status: "open",
        stripeInvoiceId: `in_${tag}`,
        createdAt: new Date("2026-09-30T23:59:59.000Z"),
      });
      await tx.insert(schema.invoices).values({
        orgId,
        stripeInvoiceId: `in_${tag}`,
        number: `OXG-${tag}`,
        status: "open",
        amountDueCents: 1,
        amountRemainingCents: 1,
        periodStart: SEPT.start,
        periodEnd: SEPT.end,
        hostedInvoiceUrl: "https://invoice.stripe.com/i/test",
        createdAt: new Date("2026-09-30T23:59:59.500Z"),
      });
      // Two more invoices beside the settlement's: the subscription's own, and
      // a prepaid order's. Each money record must reach its own invoice only.
      await tx.insert(schema.invoices).values([
        {
          orgId,
          stripeInvoiceId: `in_${tag}_sub`,
          number: `SUB-${tag}`,
          status: "paid",
          amountDueCents: 50_000,
          amountPaidCents: 50_000,
          amountRemainingCents: 0,
          periodStart: SEPT.start,
          periodEnd: SEPT.end,
          createdAt: new Date("2026-09-10T00:00:00.000Z"),
          paidAt: new Date("2026-09-10T00:05:00.000Z"),
        },
        {
          orgId,
          stripeInvoiceId: `in_${tag}_pre`,
          number: `PRE-${tag}`,
          status: "open",
          amountDueCents: 450,
          amountRemainingCents: 450,
          periodStart: SEPT.start,
          periodEnd: SEPT.start,
          createdAt: new Date("2026-09-20T00:00:00.000Z"),
        },
      ]);
      await tx.insert(schema.prepaidOrders).values({
        orgId,
        agreementRef: `MSA-${tag}`,
        poNumber: "PO-1",
        gauQuantity: 1_000,
        ratePerGauMicros: 4_500n,
        status: "open",
        stripeInvoiceId: `in_${tag}_pre`,
        createdAt: new Date("2026-09-20T00:00:00.000Z"),
      });
      // A draft never appears.
      await tx.insert(schema.invoices).values({
        orgId,
        stripeInvoiceId: `in_${tag}_draft`,
        status: "draft",
        amountDueCents: 99,
        amountRemainingCents: 99,
        periodStart: SEPT.start,
        periodEnd: SEPT.end,
        createdAt: new Date("2026-09-15T00:00:00.000Z"),
      });
      await tx.insert(schema.creditLedger).values([
        {
          orgId,
          deltaCents: 1_000n,
          reason: "grant_signup",
          createdAt: new Date("2026-08-01T00:00:00Z"),
        },
        {
          orgId,
          deltaCents: 500n,
          reason: "grant_credit_pack",
          createdAt: new Date("2026-09-03T00:00:00Z"),
        },
        {
          orgId,
          deltaCents: -30n,
          reason: "consume_assistant_tokens",
          createdById: userId,
          createdAt: new Date("2026-09-04T00:00:00Z"),
        },
        {
          orgId,
          deltaCents: -20n,
          reason: "consume_assistant_tokens",
          createdAt: new Date("2026-09-05T00:00:00Z"),
        },
        {
          orgId,
          deltaCents: -10n,
          reason: "consume_embedding",
          createdAt: new Date("2026-09-06T00:00:00Z"),
        },
        {
          orgId,
          deltaCents: -7n,
          reason: "consume_embedding",
          createdAt: new Date("2026-10-06T00:00:00Z"),
        },
        {
          orgId: otherOrgId,
          deltaCents: 9_999n,
          reason: "grant_signup",
          createdAt: new Date("2026-09-03T00:00:00Z"),
        },
      ]);
      await tx.insert(schema.dailyTotals).values({
        orgId,
        workspaceId,
        day: "2026-09-05",
        groupKind: "model",
        groupKey: "claude-sonnet-5",
        provider: "anthropic",
        runs: 2,
        calls: 7,
        costMicros: 123_000n,
        costBasis: "gateway_observed",
        tokens: {
          input_uncached: 100,
          cache_read: 50,
          cache_write_5m: 0,
          cache_write_1h: 0,
          output: 30,
          reasoning: 5,
        },
        rolledUpAt: new Date("2026-09-06T00:00:00Z"),
      });
    });
  });

  afterAll(async () => {
    const orgs = [orgId, otherOrgId];
    await withSystemDb(async (tx) => {
      await tx
        .delete(schema.gauLedger)
        .where(inArray(schema.gauLedger.orgId, orgs));
      await tx
        .delete(schema.gauSettlements)
        .where(inArray(schema.gauSettlements.orgId, orgs));
      await tx
        .delete(schema.prepaidOrders)
        .where(inArray(schema.prepaidOrders.orgId, orgs));
      await tx
        .delete(schema.invoices)
        .where(inArray(schema.invoices.orgId, orgs));
      await tx
        .delete(schema.gauBuckets)
        .where(inArray(schema.gauBuckets.orgId, orgs));
      await tx
        .delete(schema.creditLedger)
        .where(inArray(schema.creditLedger.orgId, orgs));
      await tx
        .delete(schema.dailyTotals)
        .where(inArray(schema.dailyTotals.orgId, orgs));
      await tx
        .delete(schema.contractTerms)
        .where(inArray(schema.contractTerms.orgId, orgs));
      await tx.delete(schema.agents).where(inArray(schema.agents.orgId, orgs));
      await tx
        .delete(schema.workspaces)
        .where(inArray(schema.workspaces.orgId, orgs));
      await tx.delete(schema.users).where(inArray(schema.users.id, [userId]));
      await tx
        .delete(schema.organizations)
        .where(inArray(schema.organizations.id, orgs));
    });
    await closeDatabase();
  });

  it("states September from the ledgers, labelled, reconciled, and fenced to the organization", async () => {
    const s = await inScope(() =>
      buildBillingStatement(orgId, period, { now: NOW }),
    );
    expect(billingStatementSchema.safeParse(s).success).toBe(true);
    expect(s.provisional).toBe(false);
    expect(s.terms).toMatchObject({
      source: "negotiated",
      agreementRef: `MSA-${tag}`,
      ratePerGauMicros: "4500",
    });
    expect(s.agreements).toHaveLength(1);

    const ga = s.governedActions;
    expect([ga.totalUnits, ga.totalActions]).toEqual([7, 4]);
    expect(ga.bySource).toEqual([
      { source: "kernel", units: 6, actions: 3 },
      { source: "tacho", units: 1, actions: 1 },
      { source: "external_tool", units: 0, actions: 0 },
    ]);
    expect(ga.byWorkspace.rows).toEqual([
      { key: null, label: null, units: 4, actions: 2 },
      { key: workspaceId, label: "Payments", units: 3, actions: 2 },
    ]);
    expect(ga.byAgent.rows[1]).toEqual({
      key: agentPublicId,
      label: "Release bot",
      units: 3,
      actions: 2,
    });
    expect(ga.byOperator.rows[0]).toEqual({
      key: userId,
      label: "Dana Ops",
      units: 6,
      actions: 3,
    });
    expect(ga.bySubject.rows).toEqual([
      {
        capability: "send_message",
        toolName: null,
        mcpServer: null,
        units: 6,
        actions: 3,
      },
      {
        capability: null,
        toolName: "Bash",
        mcpServer: null,
        units: 1,
        actions: 1,
      },
    ]);
    expect(ga.daily).toHaveLength(30);
    expect(ga.daily[1]).toEqual({ date: "2026-09-02", units: 4, actions: 3 });
    expect(ga.daily[29]).toEqual({ date: "2026-09-30", units: 3, actions: 1 });

    expect(s.buckets).toHaveLength(1);
    expect(s.buckets[0]).toMatchObject({
      usedGau: 7,
      ledgerUnits: 7,
      unitsInPeriod: 7,
      remainingGau: -2,
      reconciliation: "matched",
    });

    expect(s.settlements).toEqual([
      expect.objectContaining({
        kind: "period_close",
        subtotalMicros: "9000",
        invoice: {
          number: `OXG-${tag}`,
          status: "open",
          hostedInvoiceUrl: "https://invoice.stripe.com/i/test",
        },
      }),
    ]);
    expect(s.invoices.map((i) => [i.number, i.kind])).toEqual([
      [`SUB-${tag}`, "subscription"],
      [`PRE-${tag}`, "prepaid_order"],
      [`OXG-${tag}`, "gau_period_close"],
    ]);
    expect(s.prepaidOrders).toEqual([
      expect.objectContaining({
        gauMicros: "4500000",
        totalMicros: "4500000",
        invoice: {
          number: `PRE-${tag}`,
          status: "open",
          hostedInvoiceUrl: null,
        },
      }),
    ]);
    expect(s.invoiceTotals).toEqual([
      {
        currency: "usd",
        invoices: 3,
        dueMicros: "504510000",
        paidMicros: "500000000",
        remainingMicros: "4510000",
      },
    ]);

    expect(s.usageCredits).toMatchObject({
      openingCredits: "1000",
      closingCredits: "1440",
      assistantCredits: "50",
      assistantByOperator: [
        { key: userId, label: "Dana Ops", credits: "30", entries: 1 },
      ],
      assistantUnattributedCredits: "20",
    });
    expect(s.modelUsage.rows).toEqual([
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        calls: 7,
        inputTokens: 150,
        outputTokens: 35,
        reportedCostMicros: "123000",
        currency: "USD",
      },
    ]);
    expect(s.reconciliation.every((c) => c.holds)).toBe(true);
  });

  it("pages every September ledger row exactly once, in order, and nothing else", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof readStatementLineItems>> =
        await inScope(() =>
          readStatementLineItems(orgId, period, { cursor, limit: 1 }),
        );
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(4);

    const all = await inScope(() =>
      readStatementLineItems(orgId, period, { cursor: null, limit: 100 }),
    );
    expect(all.items.map((i) => i.id)).toEqual(seen);
    expect(all.nextCursor).toBeNull();
    expect(all.items.reduce((n, i) => n + i.units, 0)).toBe(7);
    const first = all.items.find((i) => i.runId === "run_a");
    expect(first).toMatchObject({
      workspace: "Payments",
      agent: "Release bot",
      operator: "Dana Ops",
      billedAt: "2026-09-02T09:00:01.000000Z",
    });
    const tacho = all.items.find((i) => i.source === "tacho");
    expect(tacho).toMatchObject({
      toolName: "Bash",
      harness: "claude-code",
      toolCallId: "toolu_1",
    });
  });

  it("refuses a cursor written for another period", async () => {
    const page = await inScope(() =>
      readStatementLineItems(orgId, period, { cursor: null, limit: 1 }),
    );
    const october = resolveStatementPeriod(
      { kind: "month", anchor: "2026-10-01" },
      NOW,
    );
    await expect(
      inScope(() =>
        readStatementLineItems(orgId, october, {
          cursor: page.nextCursor,
          limit: 1,
        }),
      ),
    ).rejects.toThrow("invalid_cursor");
  });
});
