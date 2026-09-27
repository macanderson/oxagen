/**
 * Usage from an organisation on its own database is delivered (#4315), and
 * the turn credit gate sees what it spent (#4338).
 *
 * ADR-134 settles a dedicated-plane organisation's model usage on the shared
 * plane, and `deliverUsageOutbox` reads the shared plane only. Two
 * organisations run the same admit, finalize, and deliver sequence:
 *
 *   1. One on the shared plane.
 *   2. One bound to a dedicated plane.
 *
 * One delivery pass must deliver both, and the dedicated organisation's
 * admission, debit, and spend counter must sit on the shared plane. Against
 * the code before #4315, `admitUsage` wrote the admission to the dedicated
 * database, and the delivery pass, which reads the shared plane, never found
 * it.
 *
 * A third organisation, also on the dedicated plane, holds one credit. The
 * gate must admit a turn on it, and refuse the next once settled usage has
 * spent it. Before #4338 the gate read the organisation's own database while
 * the debit landed on the shared one. There the gate found no credit and
 * refused the first turn.
 *
 * The dedicated plane is migrated the way the rls-integration job migrates
 * the shared one, because ADR-042 §3 runs the full migration set on every
 * dedicated plane. A billing read that reaches it therefore answers with no
 * rows, as it would in production. The last case checks that no billing row
 * landed there.
 *
 * CI: rls-integration job (`TENANT_RLS_ENFORCEMENT_ENABLED=true`).
 */
import { execFileSync, type StdioOptions } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { effectiveBalance, owedCredits } from "../src/credits";
import {
  assertCanStartTurn,
  assistantSpendThisMonth,
  InsufficientCreditsError,
} from "../src/metering";

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
/** On the dedicated plane, with a balance smaller than one usage costs. */
const GATE_ORG = "00000000-0000-0000-4315-000000000003";
const WORKSPACE = "00000000-0000-0000-4315-000000000010";
const ORGS = [SHARED_ORG, DEDICATED_ORG, GATE_ORG];
const DEDICATED_ORGS = new Set([DEDICATED_ORG, GATE_ORG]);

/** Credits each organisation starts with, granted on the shared plane. */
const BALANCE: Record<string, bigint> = {
  [SHARED_ORG]: 100_000n,
  [DEDICATED_ORG]: 100_000n,
  [GATE_ORG]: 1n,
};

/** A migrated database that stands in for a customer's dedicated plane. */
const DEDICATED_DATABASE = "usage_outbox_dedicated_witness";

/** The billing tables that must stay empty on the dedicated plane. */
const BILLING_TABLES = [
  "credit_balances",
  "credit_lots",
  "credit_ledger",
  "org_billing_settings",
  "spend_counters",
  "usage_outbox",
];

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The migration set takes longer than the default hook timeout. */
const MIGRATE_TIMEOUT_MS = 300_000;

const admin = postgres(process.env["DATABASE_URL"]!, {
  max: 1,
  prepare: false,
});

function dedicatedDatabaseUrl(): string {
  const url = new URL(process.env["DATABASE_URL"]!);
  url.pathname = `/${DEDICATED_DATABASE}`;
  return url.toString();
}

/**
 * Apply the rls-integration job's two Postgres steps to the dedicated plane:
 * the extension bootstrap, then `atlas migrate apply --env ci`. Their output
 * is the full migration SQL, so only stderr reaches the log.
 */
function migrateDedicatedPlane(): void {
  const url = dedicatedDatabaseUrl();
  const stdio: StdioOptions = ["ignore", "ignore", "inherit"];
  execFileSync(
    "psql",
    [url, "-f", join(REPO_ROOT, "tools/scripts/init-postgres.sql")],
    { stdio },
  );
  execFileSync("atlas", ["migrate", "apply", "--env", "ci"], {
    cwd: join(REPO_ROOT, "packages/database"),
    env: { ...process.env, DATABASE_URL: url },
    stdio,
  });
}

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
      const cents = BALANCE[orgId]!;
      await tx
        .insert(schema.creditBalances)
        .values({ orgId, balanceCents: cents });
      await tx.insert(schema.creditLots).values({
        orgId,
        source: "free_grant",
        originalCents: cents,
        remainingCents: cents,
        grantedAt: new Date(),
        expiresAt: null,
      });
    }
  });
  await admin.unsafe(
    `DROP DATABASE IF EXISTS ${DEDICATED_DATABASE} WITH (FORCE)`,
  );
  await admin.unsafe(`CREATE DATABASE ${DEDICATED_DATABASE}`);
  migrateDedicatedPlane();
  const url = new URL(process.env["DATABASE_URL"]!);
  setDataPlaneResolver(async (orgId, kind) =>
    DEDICATED_ORGS.has(orgId) && kind === "postgres"
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
}, MIGRATE_TIMEOUT_MS);

afterAll(async () => {
  clearDataPlaneResolver();
  for (const orgId of DEDICATED_ORGS)
    evictDedicatedPlanePools(orgId, "test finished");
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

    // Rows another suite left behind can add to the pass's counts, so the
    // assertions below name this test's two admissions.
    const pass = await deliverUsageOutbox(100, new Date(Date.now() + 60_000));
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

describe("the turn credit gate for an organisation on a dedicated plane", () => {
  const inGateScope = <T>(fn: () => Promise<T>) =>
    runInTenantScope({ orgId: GATE_ORG, workspaceId: WORKSPACE }, fn);

  it("admits a turn on the balance, then refuses once settled usage spends it", async () => {
    // The credit was granted on the shared plane. Before #4338 the gate read
    // the organisation's own database for it, found no credit there, and
    // refused this turn.
    await expect(
      inGateScope(() => assertCanStartTurn(GATE_ORG)),
    ).resolves.toBeUndefined();

    // One usage costs more than the one credit the organisation holds. The
    // lot is drained and the rest is kept as a debt.
    await recordUsage(GATE_ORG);

    await expect(
      inGateScope(() => assertCanStartTurn(GATE_ORG)),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
    await expect(inGateScope(() => effectiveBalance(GATE_ORG))).resolves.toBe(
      0n,
    );
    expect(await inGateScope(() => owedCredits(GATE_ORG))).toBeGreaterThan(0n);
    // The monthly assistant spend cap counts the debit that settled.
    await expect(
      inGateScope(() => assistantSpendThisMonth(GATE_ORG)),
    ).resolves.toBe(BALANCE[GATE_ORG]);
  });
});

describe("the dedicated plane after every case above", () => {
  it("holds no billing row for either organisation on it", async () => {
    const plane = postgres(dedicatedDatabaseUrl(), { max: 1, prepare: false });
    try {
      for (const table of BILLING_TABLES) {
        const [row] = await plane.unsafe<Array<{ n: number }>>(
          `select count(*)::int as n from billing.${table} where org_id = any($1::uuid[])`,
          [[...DEDICATED_ORGS]],
        );
        expect(row?.n, `billing.${table}`).toBe(0);
      }
    } finally {
      await plane.end();
    }
  });
});
