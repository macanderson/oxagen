/**
 * The spend counter a tenant transaction writes is the counter the gate reads
 * (#3825, #4306).
 *
 * Tacho ingest and usage settlement call `recordSpend(args, tx)` inside
 * `withTenantDb`. The budget gate reads the counter with `sumSpendCounter`,
 * which runs on the shared plane (ADR-042 §2, ADR-134). Two cases:
 *
 *   1. Shared plane, as the real application role. `oxagen_app` is not a
 *      superuser, so the FORCE RLS `tenant_isolation` policy on
 *      `billing.spend_counters` applies to the insert and to the
 *      `ON CONFLICT DO UPDATE` a second write takes. A write that names
 *      another organisation is refused, which shows the policy is live.
 *   2. Dedicated plane. The organisation's plane is an empty database with no
 *      billing schema. `withTenantDb` opens its transaction there, and the
 *      counter write must still reach the shared plane. Against the code
 *      before #4306 the insert ran on the dedicated plane and failed with
 *      "relation does not exist".
 *
 * CI: rls-integration job (`TENANT_RLS_ENFORCEMENT_ENABLED=true`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq, inArray, sql } from "drizzle-orm";
import {
  evictDedicatedPlanePools,
  schema,
  withSystemDb,
  withTenantDb,
} from "@oxagen/database";
import {
  clearDataPlaneResolver,
  runInTenantScope,
  setDataPlaneResolver,
} from "@oxagen/tenancy";
import { recordSpend, sumSpendCounter } from "../src/spend-counter";

const SHARED_ORG = "00000000-0000-0000-0089-000000000001";
const DEDICATED_ORG = "00000000-0000-0000-0089-000000000002";
const OTHER_ORG = "00000000-0000-0000-0089-000000000003";
const WORKSPACE = "00000000-0000-0000-0089-000000000010";
const ORGS = [SHARED_ORG, DEDICATED_ORG, OTHER_ORG];

/** The real application role. Non-superuser, no BYPASSRLS. */
const APP_ROLE = "oxagen_app";
/** An empty database that stands in for a customer's dedicated plane. */
const DEDICATED_DATABASE = "spend_counter_dedicated_witness";
/** insufficient_privilege: a row the WITH CHECK clause refused. */
const RLS_REFUSAL = "42501";

const AT = new Date("2026-09-25T12:00:00Z");
const WINDOW = { periodStart: AT, periodEnd: AT };

const admin = postgres(process.env["DATABASE_URL"]!, {
  max: 1,
  prepare: false,
});

/** The Postgres error code under whatever wrapper the driver added. */
function pgCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function cleanup(): Promise<void> {
  await withSystemDb(async (tx) => {
    await tx
      .delete(schema.spendCounters)
      .where(inArray(schema.spendCounters.orgId, ORGS));
    await tx
      .delete(schema.organizations)
      .where(inArray(schema.organizations.id, ORGS));
  });
}

beforeAll(async () => {
  await cleanup();
  await withSystemDb((tx) =>
    tx.insert(schema.organizations).values(
      ORGS.map((id, index) => ({
        id,
        name: `Spend counter witness ${index}`,
        slug: `spend-counter-witness-${index}`,
        namespace: `scw${index}`,
        planType: "free" as const,
        status: "active" as const,
      })),
    ),
  );
  await admin.unsafe(
    `DROP DATABASE IF EXISTS ${DEDICATED_DATABASE} WITH (FORCE)`,
  );
  await admin.unsafe(`CREATE DATABASE ${DEDICATED_DATABASE}`);
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

describe("spend counter written from a tenant transaction", () => {
  it("adds both writes on the shared plane as the application role", async () => {
    const write = (micros: bigint) =>
      runInTenantScope({ orgId: SHARED_ORG, workspaceId: WORKSPACE }, () =>
        withTenantDb(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE}`));
          await recordSpend(
            { orgId: SHARED_ORG, workspaceId: WORKSPACE, at: AT, micros },
            tx,
          );
        }),
      );
    // The first write inserts the day's row, the second takes the
    // ON CONFLICT DO UPDATE branch.
    await write(1_200n);
    await write(800n);

    await expect(
      sumSpendCounter({ orgId: SHARED_ORG, workspaceId: WORKSPACE, ...WINDOW }),
    ).resolves.toBe(2_000n);
    await expect(
      sumSpendCounter({ orgId: SHARED_ORG, ...WINDOW }),
    ).resolves.toBe(2_000n);
    const rows = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.spendCounters)
        .where(eq(schema.spendCounters.orgId, SHARED_ORG)),
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses a write for another organisation under the tenant policy", async () => {
    const error = await runInTenantScope(
      { orgId: SHARED_ORG, workspaceId: WORKSPACE },
      () =>
        withTenantDb(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE}`));
          await recordSpend(
            { orgId: OTHER_ORG, workspaceId: WORKSPACE, at: AT, micros: 500n },
            tx,
          );
        }),
    ).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(pgCode(error)).toBe(RLS_REFUSAL);
    await expect(
      sumSpendCounter({ orgId: OTHER_ORG, ...WINDOW }),
    ).resolves.toBe(0n);
  });

  it("reaches the shared-plane counter from a transaction on a dedicated plane", async () => {
    const url = new URL(process.env["DATABASE_URL"]!);
    setDataPlaneResolver(async (orgId, kind) =>
      orgId === DEDICATED_ORG && kind === "postgres"
        ? {
            orgId,
            kind,
            mode: "dedicated",
            status: "active",
            configDigest: "spend-counter-witness",
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
    try {
      await runInTenantScope(
        { orgId: DEDICATED_ORG, workspaceId: WORKSPACE },
        () =>
          withTenantDb(async (tx) => {
            // The transaction is on the empty database: it has no billing
            // schema to write into.
            const [plane] = await tx.execute<{ name: string }>(
              sql`select current_database() as name`,
            );
            expect(plane?.name).toBe(DEDICATED_DATABASE);
            await recordSpend(
              {
                orgId: DEDICATED_ORG,
                workspaceId: WORKSPACE,
                at: AT,
                micros: 1_500n,
              },
              tx,
            );
          }),
      );
    } finally {
      clearDataPlaneResolver();
    }

    await expect(
      sumSpendCounter({
        orgId: DEDICATED_ORG,
        workspaceId: WORKSPACE,
        ...WINDOW,
      }),
    ).resolves.toBe(1_500n);
  });
});
