/**
 * Usage from an organisation on its own database is delivered (#4315).
 *
 * ADR-134 settles a dedicated-plane organisation's model usage on the shared
 * plane, and `deliverUsageOutbox` reads the shared plane only. Two
 * organisations run the same admit, finalize, and deliver sequence:
 *
 *   1. One on the shared plane.
 *   2. One bound to a dedicated plane. That plane is an empty database with
 *      no billing schema, so a write that lands there fails.
 *
 * One delivery pass must deliver both, and the dedicated organisation's
 * admission, debit, and spend counter must sit on the shared plane. Against
 * the code before #4315, `admitUsage` opened its transaction on the empty
 * database and failed with `relation "billing.usage_outbox" does not exist`.
 *
 * CI: rls-integration job (`TENANT_RLS_ENFORCEMENT_ENABLED=true`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { and, eq, inArray } from "drizzle-orm";
import {
  evictDedicatedPlanePools,
  schema,
  withSystemDb,
} from "@oxagen/database";
import {
  clearDataPlaneResolver,
  runInTenantScope,
  setDataPlaneResolver,
} from "@oxagen/tenancy";
import type { TokenUsageRow } from "@oxagen/telemetry";
import { CREDIT_REASONS } from "../src/constants";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(async (_id: string, _row: TokenUsageRow) => undefined),
}));
vi.mock("@oxagen/telemetry", async (original) => ({
  ...(await original<typeof import("@oxagen/telemetry")>()),
  insertDurableTokenUsage: mocks.insert,
}));

import {
  admitUsage,
  deliverUsageOutbox,
  finalizeUsage,
  voidUsage,
} from "../src/usage-outbox";

const SHARED_ORG = "00000000-0000-0000-4315-000000000001";
const DEDICATED_ORG = "00000000-0000-0000-4315-000000000002";
const WORKSPACE = "00000000-0000-0000-4315-000000000010";
const ORGS = [SHARED_ORG, DEDICATED_ORG];

/** An empty database that stands in for a customer's dedicated plane. */
const DEDICATED_DATABASE = "usage_outbox_dedicated_witness";

const admin = postgres(process.env["DATABASE_URL"]!, {
  max: 1,
  prepare: false,
});

function usageRow(orgId: string): TokenUsageRow {
  return {
    org_id: orgId,
    workspace_id: WORKSPACE,
    execution_step_id: null,
    model: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    input_tokens: 100_100,
    output_tokens: 0,
    cached_tokens: 0,
    cost_usd_micros: 300_300,
    duration_ms: 10,
    surface: "api",
    prompt_hash: "hash",
    created_at: new Date().toISOString(),
  };
}

function usageCharge(orgId: string) {
  return {
    orgId,
    reason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
    model: "anthropic/claude-sonnet-5",
    inputTokens: 100_100,
    outputTokens: 0,
    markup: 1,
  };
}

/** Admit and finalize one usage inside the organisation's tenant scope. */
async function recordUsage(orgId: string): Promise<string> {
  return runInTenantScope({ orgId, workspaceId: WORKSPACE }, async () => {
    const id = await admitUsage(orgId, WORKSPACE);
    await finalizeUsage({
      id,
      row: usageRow(orgId),
      charge: usageCharge(orgId),
    });
    return id;
  });
}

async function cleanup(): Promise<void> {
  await withSystemDb(async (tx) => {
    for (const table of [
      schema.usageOutbox,
      schema.creditLedger,
      schema.creditLots,
      schema.spendCounters,
      schema.orgBillingSettings,
      schema.creditBalances,
    ])
      await tx.delete(table).where(inArray(table.orgId, ORGS));
    await tx
      .delete(schema.organizations)
      .where(inArray(schema.organizations.id, ORGS));
  });
}

beforeAll(async () => {
  await cleanup();
  await withSystemDb(async (tx) => {
    await tx.insert(schema.organizations).values(
      ORGS.map((id, index) => ({
        id,
        name: `Usage outbox plane witness ${index}`,
        slug: `usage-outbox-plane-witness-${index}`,
        namespace: `uop${index}`,
        planType: "free" as const,
        status: "active" as const,
      })),
    );
    for (const orgId of ORGS) {
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
    }
  });
  await admin.unsafe(
    `DROP DATABASE IF EXISTS ${DEDICATED_DATABASE} WITH (FORCE)`,
  );
  await admin.unsafe(`CREATE DATABASE ${DEDICATED_DATABASE}`);
  const url = new URL(process.env["DATABASE_URL"]!);
  setDataPlaneResolver(async (orgId, kind) =>
    orgId === DEDICATED_ORG && kind === "postgres"
      ? {
          orgId,
          kind,
          mode: "dedicated",
          status: "active",
          configDigest: "usage-outbox-dedicated-witness",
          config: {
            host: url.hostname,
            port: Number(url.port || 5432),
            database: DEDICATED_DATABASE,
            username: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            ssl: false,
            maxConnections: 1,
          },
        }
      : { orgId, kind, mode: "shared", status: "active" },
  );
});

afterAll(async () => {
  clearDataPlaneResolver();
  evictDedicatedPlanePools(DEDICATED_ORG, "test finished");
  try {
    await cleanup();
    await admin.unsafe(
      `DROP DATABASE IF EXISTS ${DEDICATED_DATABASE} WITH (FORCE)`,
    );
  } finally {
    await admin.end();
  }
});

describe("usage outbox across a shared and a dedicated plane", () => {
  it("delivers usage from both organisations in one pass", async () => {
    const sharedId = await recordUsage(SHARED_ORG);
    const dedicatedId = await recordUsage(DEDICATED_ORG);

    const pass = await deliverUsageOutbox(100, new Date(Date.now() + 60_000));
    expect(pass.failed).toBe(0);
    expect(pass.delivered).toBeGreaterThanOrEqual(2);
    const deliveredIds = mocks.insert.mock.calls.map(([id]) => id);
    expect(deliveredIds).toEqual(
      expect.arrayContaining([sharedId, dedicatedId]),
    );

    const entries = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.usageOutbox)
        .where(inArray(schema.usageOutbox.id, [sharedId, dedicatedId])),
    );
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.deliveredAt).not.toBeNull();
      expect(entry.finalizedAt).not.toBeNull();
      expect(entry.payload).toBeNull();
    }
  });

  it("settles the dedicated organisation's debit and spend on the shared plane", async () => {
    const ledger = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.creditLedger)
        .where(
          and(
            eq(schema.creditLedger.orgId, DEDICATED_ORG),
            eq(
              schema.creditLedger.reason,
              CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
            ),
          ),
        ),
    );
    const counters = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.spendCounters)
        .where(eq(schema.spendCounters.orgId, DEDICATED_ORG)),
    );
    expect(ledger).toHaveLength(1);
    expect(counters).toHaveLength(1);
    expect(counters[0]?.spentMicros).toBe(300_300n);
  });

  it("voids a dedicated organisation's admission on the shared plane", async () => {
    const id = await runInTenantScope(
      { orgId: DEDICATED_ORG, workspaceId: WORKSPACE },
      async () => {
        const admitted = await admitUsage(DEDICATED_ORG, WORKSPACE);
        await expect(
          voidUsage({
            id: admitted,
            orgId: DEDICATED_ORG,
            workspaceId: WORKSPACE,
            reason: "provider_call_failed",
          }),
        ).resolves.toBe(true);
        return admitted;
      },
    );
    const [entry] = await withSystemDb((tx) =>
      tx.select().from(schema.usageOutbox).where(eq(schema.usageOutbox.id, id)),
    );
    expect(entry?.usageComplete).toBe(true);
    expect(entry?.finalizedAt).not.toBeNull();
  });
});
