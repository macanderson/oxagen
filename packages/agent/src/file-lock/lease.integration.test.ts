import {
  describe,
  expect,
  it,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { sql } from "drizzle-orm";

/**
 * Integration tests for the Postgres file-lock lease (ADR-021 §5). The atomic
 * acquire (advisory lock + conditional upsert + partial unique index) and the
 * fencing-token counter cannot be meaningfully mocked, so these run against the
 * local Postgres (:5433) and skip cleanly when it is unreachable (CI unit lane).
 * The SQL under test is the exact production statement — withTenantDb is routed
 * to withSystemDb so the lease runs verbatim without a full tenancy bootstrap.
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
const {
  acquireFileLease,
  renewFileLease,
  releaseFileLease,
  releaseFileLeasesByExecution,
  verifyFileLease,
  sweepExpiredFileLeases,
  listFileLeases,
} = await import("./lease");

const ORG_ID = "00000000-0000-4000-8000-0000000010c1";
const WS_ID = "00000000-0000-4000-8000-0000000010c2";
const scope = { orgId: ORG_ID, workspaceId: WS_ID };

let dbUp = false;

async function cleanup() {
  await withSystemDb((tx) =>
    tx.execute(
      sql`DELETE FROM agent.file_locks WHERE workspace_id = ${WS_ID}::uuid`,
    ),
  );
  await withSystemDb((tx) =>
    tx.execute(
      sql`DELETE FROM agent.file_lock_fences WHERE workspace_id = ${WS_ID}::uuid`,
    ),
  );
}

/** Force a live lock's lease into the past to simulate TTL expiry deterministically. */
async function expireLock(resourceKey: string) {
  await withSystemDb((tx) =>
    tx.execute(sql`
      UPDATE agent.file_locks SET lease_expires_at = now() - interval '1 hour'
      WHERE workspace_id = ${WS_ID}::uuid AND resource_key = ${resourceKey} AND released_at IS NULL
    `),
  );
}

beforeAll(async () => {
  try {
    await withSystemDb((tx) => tx.execute(sql`SELECT 1`));
    dbUp = true;
  } catch {
    dbUp = false;
  }
});

beforeEach(async () => {
  if (dbUp) await cleanup();
});

afterAll(async () => {
  if (dbUp) await cleanup();
});

describe("acquireFileLease (integration)", () => {
  it("grants a lock, issues fencing token 1, and lists it", async () => {
    if (!dbUp) return;
    const res = await acquireFileLease({
      ...scope,
      resourceKeys: ["src/a.ts"],
      holder: "task-1",
      executionId: "exec-1",
    });
    expect(res.conflicts).toEqual([]);
    expect(res.acquired).toHaveLength(1);
    expect(res.acquired[0]?.fencingToken).toBe(1);

    const { leases } = await listFileLeases({ ...scope });
    expect(leases).toHaveLength(1);
    expect(leases[0]?.holder).toBe("task-1");
  });

  it("contention: a second holder is denied while the first holds the lock", async () => {
    if (!dbUp) return;
    await acquireFileLease({
      ...scope,
      resourceKeys: ["src/a.ts"],
      holder: "task-1",
      executionId: "exec-1",
    });
    const second = await acquireFileLease({
      ...scope,
      resourceKeys: ["src/a.ts"],
      holder: "task-2",
      executionId: "exec-2",
    });
    expect(second.acquired).toEqual([]);
    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0]?.holder).toBe("task-1");
  });

  it("the same holder renews (not a conflict) and the fence advances monotonically", async () => {
    if (!dbUp) return;
    const a = await acquireFileLease({
      ...scope,
      resourceKeys: ["src/a.ts"],
      holder: "task-1",
      executionId: "exec-1",
    });
    const b = await acquireFileLease({
      ...scope,
      resourceKeys: ["src/a.ts"],
      holder: "task-1",
      executionId: "exec-1",
    });
    expect(b.acquired).toHaveLength(1);
    expect(b.acquired[0]?.fencingToken).toBeGreaterThan(
      a.acquired[0]?.fencingToken as number,
    );
  });

  it("TTL expiry: a new holder takes over an expired lease with a strictly higher fencing token", async () => {
    if (!dbUp) return;
    const first = await acquireFileLease({
      ...scope,
      resourceKeys: ["src/a.ts"],
      holder: "task-1",
      executionId: "exec-1",
    });
    await expireLock("src/a.ts");
    const second = await acquireFileLease({
      ...scope,
      resourceKeys: ["src/a.ts"],
      holder: "task-2",
      executionId: "exec-2",
    });
    expect(second.acquired).toHaveLength(1);
    expect(second.acquired[0]?.fencingToken).toBeGreaterThan(
      first.acquired[0]?.fencingToken as number,
    );
  });

  it("atomic multi-key: acquiring [b,c] fails wholesale when b is held, leaving c free", async () => {
    if (!dbUp) return;
    await acquireFileLease({
      ...scope,
      resourceKeys: ["b.ts"],
      holder: "task-1",
      executionId: "exec-1",
    });
    const res = await acquireFileLease({
      ...scope,
      resourceKeys: ["b.ts", "c.ts"],
      holder: "task-2",
      executionId: "exec-2",
    });
    expect(res.acquired).toEqual([]);
    expect(res.conflicts.map((c) => c.resourceKey)).toContain("b.ts");
    // c.ts must NOT have been locked (all-or-nothing) — task-3 can take it.
    const c = await acquireFileLease({
      ...scope,
      resourceKeys: ["c.ts"],
      holder: "task-3",
      executionId: "exec-3",
    });
    expect(c.acquired).toHaveLength(1);
  });
});

describe("verifyFileLease / renew / release (integration)", () => {
  it("verifyFileLease: the stale holder's token fails after a takeover, the new one passes", async () => {
    if (!dbUp) return;
    const first = await acquireFileLease({
      ...scope,
      resourceKeys: ["src/a.ts"],
      holder: "task-1",
      executionId: "exec-1",
    });
    const staleToken = first.acquired[0]?.fencingToken as number;
    await expireLock("src/a.ts");
    const second = await acquireFileLease({
      ...scope,
      resourceKeys: ["src/a.ts"],
      holder: "task-2",
      executionId: "exec-2",
    });
    const freshToken = second.acquired[0]?.fencingToken as number;

    expect(
      await verifyFileLease({
        ...scope,
        resourceKey: "src/a.ts",
        fencingToken: staleToken,
      }),
    ).toBe(false);
    expect(
      await verifyFileLease({
        ...scope,
        resourceKey: "src/a.ts",
        fencingToken: freshToken,
      }),
    ).toBe(true);
  });

  it("renewFileLease extends the caller's lease but rejects a non-holder", async () => {
    if (!dbUp) return;
    const a = await acquireFileLease({
      ...scope,
      resourceKeys: ["src/a.ts"],
      holder: "task-1",
      executionId: "exec-1",
    });
    const lockId = a.acquired[0]?.lockId as string;
    const good = await renewFileLease({ ...scope, lockId, holder: "task-1" });
    expect(good.renewed).toBe(true);
    const bad = await renewFileLease({
      ...scope,
      lockId,
      holder: "someone-else",
    });
    expect(bad.renewed).toBe(false);
  });

  it("releaseFileLease (force, no holder) frees the resource; releaseByExecution frees the batch", async () => {
    if (!dbUp) return;
    const a = await acquireFileLease({
      ...scope,
      resourceKeys: ["one.ts"],
      holder: "task-1",
      executionId: "exec-1",
    });
    const lockId = a.acquired[0]?.lockId as string;
    expect((await releaseFileLease({ ...scope, lockId })).released).toBe(true);
    // Idempotent second release.
    expect((await releaseFileLease({ ...scope, lockId })).released).toBe(false);

    await acquireFileLease({
      ...scope,
      resourceKeys: ["two.ts", "three.ts"],
      holder: "task-2",
      executionId: "exec-2",
    });
    const batch = await releaseFileLeasesByExecution({
      ...scope,
      executionId: "exec-2",
    });
    expect(batch.released).toBe(2);
    expect((await listFileLeases({ ...scope })).leases).toHaveLength(0);
  });

  it("sweepExpiredFileLeases soft-releases expired-but-unreleased locks", async () => {
    if (!dbUp) return;
    await acquireFileLease({
      ...scope,
      resourceKeys: ["stale.ts"],
      holder: "task-1",
      executionId: "exec-1",
    });
    await expireLock("stale.ts");
    const swept = await sweepExpiredFileLeases({ ...scope });
    expect(swept.swept).toBe(1);
    expect((await listFileLeases({ ...scope })).leases).toHaveLength(0);
  });
});
