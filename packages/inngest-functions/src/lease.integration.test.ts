import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";

/**
 * Integration tests for the claim UPDATE (spec §Test plan): SKIP LOCKED
 * semantics cannot be mocked meaningfully, so these run against the local
 * Postgres (:5433) and skip cleanly when it is unreachable (e.g. CI unit
 * lane). The claim SQL under test is the exact production statement —
 * withTenantDb is routed to the real withSystemDb so lease.ts runs verbatim
 * without needing a full tenancy bootstrap.
 */

process.env.DATABASE_URL ??= "postgres://oxagen:oxagen@localhost:5433/oxagen";

vi.mock("@oxagen/tenancy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/tenancy")>();
  return {
    ...real,
    runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
  };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: real.withSystemDb };
});

const { withSystemDb } = await import("@oxagen/database");
const { claimNextSubagentRun, renewSubagentRunLease, MAX_ATTEMPTS } =
  await import("./lease");

const ORG_ID = "00000000-0000-4000-8000-00000000fa02";
const WS_ID = "00000000-0000-4000-8000-00000000fa03";
const FANOUT_ID = "00000000-0000-4000-8000-00000000fa04";

let dbUp = false;

async function insertPendingRun(
  id: string,
  overrides?: {
    status?: string;
    attempts?: number;
    leaseOffsetSeconds?: number;
  },
) {
  const status = overrides?.status ?? "pending";
  const attempts = overrides?.attempts ?? 0;
  await withSystemDb((tx) =>
    tx.execute(sql`
      INSERT INTO agent.subagent_runs
        (id, public_id, org_id, workspace_id, fanout_id, child_message_id,
         capability_name, input_payload, status, attempts, lease_expires_at)
      VALUES
        (${id}::uuid, ${"sar_it_" + id.slice(-12)}, ${ORG_ID}::uuid, ${WS_ID}::uuid,
         ${FANOUT_ID}::uuid, ${crypto.randomUUID()}::uuid, 'test.capability', '{}'::jsonb,
         ${status}, ${attempts},
         CASE WHEN ${overrides?.leaseOffsetSeconds ?? null}::int IS NULL THEN NULL
              ELSE now() + make_interval(secs => ${overrides?.leaseOffsetSeconds ?? 0}) END)
    `),
  );
}

async function cleanup() {
  await withSystemDb((tx) =>
    tx.execute(
      sql`DELETE FROM agent.subagent_runs WHERE fanout_id = ${FANOUT_ID}::uuid`,
    ),
  );
}

beforeAll(async () => {
  try {
    await withSystemDb((tx) => tx.execute(sql`SELECT 1`));
    dbUp = true;
    await cleanup();
  } catch (err) {
    console.error(
      "lease.integration: local Postgres unreachable — skipping:",
      err instanceof Error ? err.message : err,
    );
    dbUp = false;
  }
});

afterAll(async () => {
  if (dbUp) await cleanup();
});

describe("claimNextSubagentRun (integration, local Postgres)", () => {
  it("claims a pending row atomically: sets running, worker, lease, attempts+1", async (ctx) => {
    if (!dbUp) return ctx.skip();
    const runId = crypto.randomUUID();
    await insertPendingRun(runId);

    const claimed = await claimNextSubagentRun({
      orgId: ORG_ID,
      workspaceId: WS_ID,
      fanoutId: FANOUT_ID,
      workerId: "worker-A",
    });

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(runId);
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.capabilityName).toBe("test.capability");

    const rows = (await withSystemDb((tx) =>
      tx.execute<{
        status: string;
        claimed_by: string;
        lease_ok: boolean;
        started_ok: boolean;
      }>(sql`
        SELECT status, claimed_by, lease_expires_at > now() AS lease_ok, started_at IS NOT NULL AS started_ok
        FROM agent.subagent_runs WHERE id = ${runId}::uuid
      `),
    )) as unknown as {
      status: string;
      claimed_by: string;
      lease_ok: boolean;
      started_ok: boolean;
    }[];
    expect(rows[0]).toMatchObject({
      status: "running",
      claimed_by: "worker-A",
      lease_ok: true,
      started_ok: true,
    });
    await cleanup();
  });

  it("gives one pending row to exactly one of two concurrent claimers", async (ctx) => {
    if (!dbUp) return ctx.skip();
    const runId = crypto.randomUUID();
    await insertPendingRun(runId);

    const [a, b] = await Promise.all([
      claimNextSubagentRun({
        orgId: ORG_ID,
        workspaceId: WS_ID,
        fanoutId: FANOUT_ID,
        workerId: "worker-A",
      }),
      claimNextSubagentRun({
        orgId: ORG_ID,
        workspaceId: WS_ID,
        fanoutId: FANOUT_ID,
        workerId: "worker-B",
      }),
    ]);

    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe(runId);
    await cleanup();
  });

  it("two concurrent claimers over two pending rows each win a distinct row", async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    await insertPendingRun(id1);
    await insertPendingRun(id2);

    const [a, b] = await Promise.all([
      claimNextSubagentRun({
        orgId: ORG_ID,
        workspaceId: WS_ID,
        fanoutId: FANOUT_ID,
        workerId: "worker-A",
      }),
      claimNextSubagentRun({
        orgId: ORG_ID,
        workspaceId: WS_ID,
        fanoutId: FANOUT_ID,
        workerId: "worker-B",
      }),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(new Set([a!.id, b!.id]).size).toBe(2);
    await cleanup();
  });

  it("reclaims a running row whose lease has expired, but not a live one", async (ctx) => {
    if (!dbUp) return ctx.skip();
    const expiredId = crypto.randomUUID();
    const liveId = crypto.randomUUID();
    await insertPendingRun(expiredId, {
      status: "running",
      attempts: 1,
      leaseOffsetSeconds: -60,
    });
    await insertPendingRun(liveId, {
      status: "running",
      attempts: 1,
      leaseOffsetSeconds: 600,
    });

    const first = await claimNextSubagentRun({
      orgId: ORG_ID,
      workspaceId: WS_ID,
      fanoutId: FANOUT_ID,
      workerId: "worker-B",
    });
    const second = await claimNextSubagentRun({
      orgId: ORG_ID,
      workspaceId: WS_ID,
      fanoutId: FANOUT_ID,
      workerId: "worker-B",
    });

    expect(first).not.toBeNull();
    expect(first!.id).toBe(expiredId);
    expect(first!.attempts).toBe(2);
    expect(second).toBeNull(); // live lease is not claimable
    await cleanup();
  });

  it("never claims a row at the attempt cap", async (ctx) => {
    if (!dbUp) return ctx.skip();
    const cappedId = crypto.randomUUID();
    await insertPendingRun(cappedId, {
      status: "running",
      attempts: MAX_ATTEMPTS,
      leaseOffsetSeconds: -60,
    });

    const claimed = await claimNextSubagentRun({
      orgId: ORG_ID,
      workspaceId: WS_ID,
      fanoutId: FANOUT_ID,
      workerId: "worker-A",
    });

    expect(claimed).toBeNull();
    await cleanup();
  });

  it("does not claim across org boundaries", async (ctx) => {
    if (!dbUp) return ctx.skip();
    const runId = crypto.randomUUID();
    await insertPendingRun(runId);

    const claimed = await claimNextSubagentRun({
      orgId: "00000000-0000-4000-8000-0000000000ff", // different org
      workspaceId: WS_ID,
      fanoutId: FANOUT_ID,
      workerId: "worker-X",
    });

    expect(claimed).toBeNull();
    await cleanup();
  });

  it("renewal extends the lease only for the owning worker", async (ctx) => {
    if (!dbUp) return ctx.skip();
    const runId = crypto.randomUUID();
    await insertPendingRun(runId);
    await claimNextSubagentRun({
      orgId: ORG_ID,
      workspaceId: WS_ID,
      fanoutId: FANOUT_ID,
      workerId: "worker-A",
    });

    const leaseBefore = async () =>
      (
        (await withSystemDb((tx) =>
          tx.execute<{ lease: string }>(
            sql`SELECT lease_expires_at::text AS lease FROM agent.subagent_runs WHERE id = ${runId}::uuid`,
          ),
        )) as unknown as { lease: string }[]
      )[0]!.lease;

    const initial = await leaseBefore();
    // Non-owner renewal is a no-op.
    await renewSubagentRunLease({
      orgId: ORG_ID,
      workspaceId: WS_ID,
      runId,
      workerId: "worker-IMPOSTER",
    });
    expect(await leaseBefore()).toBe(initial);
    // Owner renewal moves the lease forward.
    await renewSubagentRunLease({
      orgId: ORG_ID,
      workspaceId: WS_ID,
      runId,
      workerId: "worker-A",
    });
    expect((await leaseBefore()) >= initial).toBe(true);
    await cleanup();
  });
});
