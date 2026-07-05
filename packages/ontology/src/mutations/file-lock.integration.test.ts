/**
 * Integration test for OXA-2070 (docs/specs/agent-file-locking/plan.md): the
 * cross-process, tenant-scoped Neo4j file lock that lets a fleet of agents
 * coordinate without clobbering each other's files.
 *
 * The atomicity guarantee — "two concurrent acquires on the SAME naturalKey
 * serialize so exactly one is granted" — cannot be proven against a mocked
 * Neo4j session (a mock can't reproduce the real driver's write-lock
 * serialization on a MERGEd node under concurrent transactions), so this runs
 * against the real local Neo4j (`bolt://localhost:7687`, started by
 * `pnpm dev`) and skips cleanly when it is unreachable (e.g. the CI unit
 * lane), mirroring `packages/ingestion/src/dedup/__tests__/resolve.integration.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

process.env.NEO4J_URI ??= "bolt://localhost:7687";
process.env.NEO4J_USERNAME ??= "neo4j";
process.env.NEO4J_PASSWORD ??= "oxagen-dev";
process.env.NEO4J_DATABASE ??= "neo4j";

const { runInTenantScope } = await import("@oxagen/tenancy");
const { driver, closeDriver } = await import("../client");
const { acquireFileLock } = await import("./acquire-file-lock");
const { releaseFileLock, releaseFileLocksByExecution } = await import("./release-file-lock");
const { sweepExpiredFileLocks } = await import("./sweep-file-locks");

// Fixed, valid-UUID-shaped tenant scope, distinct from other integration
// suites' fixture ids so a parallel test run never collides on the same
// naturalKey+orgId node.
const ORG_ID = "00000000-0000-4000-8000-0000000da207";
const WORKSPACE_ID = "00000000-0000-4000-8000-0000000da208";

function naturalKey(suffix: string): string {
  return `github:oxa-2070-file-lock-regression:${suffix}`;
}

let neo4jUp = false;

/**
 * Ensure the one schema object the two-agent race test depends on — the
 * composite `(naturalKey, orgId)` uniqueness constraint on `:SourceFile`
 * (schema.cypher / acquire-file-lock.ts §Atomicity). Without it, two concurrent
 * `MERGE (f:SourceFile {naturalKey, orgId})` transactions don't serialise, so
 * the race either double-grants or hangs on lock contention (the "Test timed out
 * in 5000ms" we saw in the CI unit lane).
 *
 * `pnpm dev` applies the full schema via `db:migrate`, but the CI unit lane
 * spins up a bare Neo4j service container and only runs the Neo4j migrate step
 * when a Postgres/telemetry migration changed — a schema.cypher-only change (or
 * an "affected" run with no migration diff at all) leaves the graph
 * unmigrated. Creating the constraint here (idempotent `IF NOT EXISTS`) makes
 * this suite hermetic regardless of the CI migrate gating.
 */
async function ensureFileLockSchema(): Promise<void> {
  const s = driver().session({ database: process.env.NEO4J_DATABASE });
  try {
    await s.run(
      `CREATE CONSTRAINT source_file_natural_key_org_unique IF NOT EXISTS
       FOR (n:SourceFile) REQUIRE (n.naturalKey, n.orgId) IS UNIQUE`,
    );
    // Constraint-backed index must be ONLINE before the race relies on its
    // serialising lock; awaiting is a no-op once it already exists.
    await s.run("CALL db.awaitIndexes(30000)");
  } catch (err) {
    // Tolerate a parallel integration suite winning the same idempotent create
    // ("An equivalent constraint already exists") — benign under `IF NOT EXISTS`.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists|equivalent/i.test(msg)) throw err;
  } finally {
    await s.close();
  }
}

async function cleanupFixtureNodes(): Promise<void> {
  const s = driver().session({ database: process.env.NEO4J_DATABASE });
  try {
    await s.run(
      `MATCH (f:SourceFile {orgId: $orgId}) WHERE f.naturalKey STARTS WITH $prefix
       DETACH DELETE f`,
      { orgId: ORG_ID, prefix: "github:oxa-2070-file-lock-regression:" },
    );
    await s.run(
      `MATCH (a:Agent {orgId: $orgId}) WHERE a.id STARTS WITH $prefix
       DETACH DELETE a`,
      { orgId: ORG_ID, prefix: "oxa-2070-agent-" },
    );
  } finally {
    await s.close();
  }
}

beforeAll(async () => {
  try {
    const s = driver().session({ database: process.env.NEO4J_DATABASE });
    try {
      await s.run("RETURN 1");
    } finally {
      await s.close();
    }
    neo4jUp = true;
    await ensureFileLockSchema();
    await cleanupFixtureNodes();
  } catch (err) {
    console.error(
      "file-lock.integration: local Neo4j unreachable — skipping:",
      err instanceof Error ? err.message : err,
    );
    neo4jUp = false;
  }
});

afterAll(async () => {
  if (neo4jUp) {
    await cleanupFixtureNodes();
    await closeDriver();
  }
});

describe("agent file locking (integration, local Neo4j) — OXA-2070", () => {
  it("two agents racing to acquire the SAME file: exactly one is granted, the other sees heldBy + blockedUntil", async (ctx) => {
    if (!neo4jUp) return ctx.skip();

    const key = naturalKey("race-target.ts");
    const now = Date.now();

    const [resultA, resultB] = await runInTenantScope({ orgId: ORG_ID, workspaceId: WORKSPACE_ID }, () =>
      Promise.all([
        acquireFileLock({
          naturalKey: key,
          agentId: "oxa-2070-agent-a",
          executionId: "turn-a",
          workspaceId: WORKSPACE_ID,
          now,
        }),
        acquireFileLock({
          naturalKey: key,
          agentId: "oxa-2070-agent-b",
          executionId: "turn-b",
          workspaceId: WORKSPACE_ID,
          now,
        }),
      ]),
    );
    const results = [
      { agentId: "oxa-2070-agent-a", result: resultA! },
      { agentId: "oxa-2070-agent-b", result: resultB! },
    ];

    const granted = results.filter((r) => r.result.granted);
    const denied = results.filter((r) => !r.result.granted);
    expect(granted).toHaveLength(1);
    expect(denied).toHaveLength(1);
    // The denied side's heldBy must name the OTHER (granted) agent.
    expect(denied[0]!.result.heldBy).toBe(granted[0]!.agentId);
    expect(denied[0]!.result.blockedUntil).toBeGreaterThan(now);

    // Ground truth: exactly one live HOLDS_LOCK edge exists on the node.
    const s = driver().session({ database: process.env.NEO4J_DATABASE });
    try {
      const countResult = await s.run(
        `MATCH (:Agent)-[l:HOLDS_LOCK]->(:SourceFile {naturalKey: $naturalKey, orgId: $orgId})
         WHERE l.expiresAt > $now
         RETURN count(l) AS c`,
        { naturalKey: key, orgId: ORG_ID, now },
      );
      expect(Number(countResult.records[0]!.get("c"))).toBe(1);
    } finally {
      await s.close();
    }
  });

  it("the SAME agent re-acquiring renews expiresAt (idempotent renew) instead of conflicting with itself", async (ctx) => {
    if (!neo4jUp) return ctx.skip();

    const key = naturalKey("renew-target.ts");
    const now = Date.now();

    const first = await runInTenantScope({ orgId: ORG_ID, workspaceId: WORKSPACE_ID }, () =>
      acquireFileLock({
        naturalKey: key,
        agentId: "oxa-2070-agent-renew",
        executionId: "turn-renew-1",
        workspaceId: WORKSPACE_ID,
        ttlMs: 1_000,
        now,
      }),
    );
    expect(first.granted).toBe(true);

    const laterNow = now + 500;
    const second = await runInTenantScope({ orgId: ORG_ID, workspaceId: WORKSPACE_ID }, () =>
      acquireFileLock({
        naturalKey: key,
        agentId: "oxa-2070-agent-renew",
        executionId: "turn-renew-2",
        workspaceId: WORKSPACE_ID,
        ttlMs: 1_000,
        now: laterNow,
      }),
    );
    // Renewal, not a conflict — the same agentId always succeeds.
    expect(second.granted).toBe(true);

    const s = driver().session({ database: process.env.NEO4J_DATABASE });
    try {
      const result = await s.run(
        `MATCH (a:Agent {id: $agentId, orgId: $orgId})-[l:HOLDS_LOCK]->(:SourceFile {naturalKey: $naturalKey, orgId: $orgId})
         RETURN count(l) AS c, l.expiresAt AS expiresAt`,
        { agentId: "oxa-2070-agent-renew", naturalKey: key, orgId: ORG_ID },
      );
      // Renewal reuses the SAME edge (MERGE on (a)-[h]->(f)) — never a second one.
      expect(Number(result.records[0]!.get("c"))).toBe(1);
      expect(Number(result.records[0]!.get("expiresAt"))).toBe(laterNow + 1_000);
    } finally {
      await s.close();
    }
  });

  it("an expired lock (past expiresAt) no longer blocks a new acquire by a different agent", async (ctx) => {
    if (!neo4jUp) return ctx.skip();

    const key = naturalKey("expiry-target.ts");
    const t0 = Date.now();

    const first = await runInTenantScope({ orgId: ORG_ID, workspaceId: WORKSPACE_ID }, () =>
      acquireFileLock({
        naturalKey: key,
        agentId: "oxa-2070-agent-expiring",
        executionId: "turn-expiring",
        workspaceId: WORKSPACE_ID,
        ttlMs: 10,
        now: t0,
      }),
    );
    expect(first.granted).toBe(true);

    // Simulate time passing well beyond the 10ms TTL.
    const afterExpiry = t0 + 60_000;
    const second = await runInTenantScope({ orgId: ORG_ID, workspaceId: WORKSPACE_ID }, () =>
      acquireFileLock({
        naturalKey: key,
        agentId: "oxa-2070-agent-fresh",
        executionId: "turn-fresh",
        workspaceId: WORKSPACE_ID,
        now: afterExpiry,
      }),
    );
    expect(second.granted).toBe(true);
  });

  it("explicit release deletes the HOLDS_LOCK edge — a released file can be re-acquired immediately", async (ctx) => {
    if (!neo4jUp) return ctx.skip();

    const key = naturalKey("release-target.ts");
    const now = Date.now();

    const acquired = await runInTenantScope({ orgId: ORG_ID, workspaceId: WORKSPACE_ID }, () =>
      acquireFileLock({
        naturalKey: key,
        agentId: "oxa-2070-agent-releaser",
        executionId: "turn-release",
        workspaceId: WORKSPACE_ID,
        now,
      }),
    );
    expect(acquired.granted).toBe(true);

    const releaseResult = await runInTenantScope({ orgId: ORG_ID, workspaceId: WORKSPACE_ID }, () =>
      releaseFileLock({ lockId: acquired.lockId, agentId: "oxa-2070-agent-releaser" }),
    );
    expect(releaseResult.released).toBe(true);

    // A DIFFERENT agent can now acquire the same file without waiting for TTL.
    const reacquired = await runInTenantScope({ orgId: ORG_ID, workspaceId: WORKSPACE_ID }, () =>
      acquireFileLock({
        naturalKey: key,
        agentId: "oxa-2070-agent-second",
        executionId: "turn-second",
        workspaceId: WORKSPACE_ID,
        now: now + 1,
      }),
    );
    expect(reacquired.granted).toBe(true);

    // Releasing an already-released lock is idempotent, not an error.
    const secondRelease = await runInTenantScope({ orgId: ORG_ID, workspaceId: WORKSPACE_ID }, () =>
      releaseFileLock({ lockId: acquired.lockId, agentId: "oxa-2070-agent-releaser" }),
    );
    expect(secondRelease.released).toBe(false);
  });

  it("batch release by executionId deletes every lock the turn holds, across multiple files, in one call", async (ctx) => {
    if (!neo4jUp) return ctx.skip();

    const keyA = naturalKey("batch-a.ts");
    const keyB = naturalKey("batch-b.ts");
    const now = Date.now();
    const executionId = "turn-batch-release";

    await runInTenantScope({ orgId: ORG_ID, workspaceId: WORKSPACE_ID }, () =>
      Promise.all([
        acquireFileLock({
          naturalKey: keyA,
          agentId: "oxa-2070-agent-batch",
          executionId,
          workspaceId: WORKSPACE_ID,
          now,
        }),
        acquireFileLock({
          naturalKey: keyB,
          agentId: "oxa-2070-agent-batch",
          executionId,
          workspaceId: WORKSPACE_ID,
          now,
        }),
      ]),
    );

    const batchResult = await runInTenantScope({ orgId: ORG_ID, workspaceId: WORKSPACE_ID }, () =>
      releaseFileLocksByExecution({ executionId }),
    );
    expect(batchResult.releasedCount).toBe(2);

    // Ground truth: no HOLDS_LOCK edges remain for this turn.
    const s = driver().session({ database: process.env.NEO4J_DATABASE });
    try {
      const result = await s.run(
        `MATCH ()-[l:HOLDS_LOCK {executionId: $executionId}]->() RETURN count(l) AS c`,
        { executionId },
      );
      expect(Number(result.records[0]!.get("c"))).toBe(0);
    } finally {
      await s.close();
    }
  });

  it("sweepExpiredFileLocks reaps expired locks system-wide, across tenants", async (ctx) => {
    if (!neo4jUp) return ctx.skip();

    const key = naturalKey("sweep-target.ts");
    const t0 = Date.now();

    await runInTenantScope({ orgId: ORG_ID, workspaceId: WORKSPACE_ID }, () =>
      acquireFileLock({
        naturalKey: key,
        agentId: "oxa-2070-agent-sweep",
        executionId: "turn-sweep",
        workspaceId: WORKSPACE_ID,
        ttlMs: 10,
        now: t0,
      }),
    );

    const sweepResult = await sweepExpiredFileLocks(t0 + 60_000);
    expect(sweepResult.sweptCount).toBeGreaterThanOrEqual(1);

    const s = driver().session({ database: process.env.NEO4J_DATABASE });
    try {
      const result = await s.run(
        `MATCH (:Agent {id: $agentId})-[l:HOLDS_LOCK]->(:SourceFile {naturalKey: $naturalKey})
         RETURN count(l) AS c`,
        { agentId: "oxa-2070-agent-sweep", naturalKey: key },
      );
      expect(Number(result.records[0]!.get("c"))).toBe(0);
    } finally {
      await s.close();
    }
  });
});
