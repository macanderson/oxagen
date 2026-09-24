// The ledger idle close against a real Postgres (#3988): the scan finds an
// open attempt only once it has been silent past the cutoff, the close seals
// it abandoned with an unobserved tail and fails its run, and a close that
// lost a race to the producer writes nothing. Runs wherever DATABASE_URL
// points at a migrated database (CI's `test` job); a local run without one is
// skipped, not red. Every row it writes is removed in afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import {
  createPostgresRunStore,
  ledgerIdleCutoff,
  listIdleLedgerAttempts,
  type IdleLedgerAttempt,
  type RunArchiveStore,
} from "@oxagen/run-ledger";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeIdleLedgerAttempt,
  LEDGER_IDLE_CLOSE_ERROR,
} from "./ledger-idle-close";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("the ledger idle close against Postgres", () => {
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const now = new Date();
  const cutoff = ledgerIdleCutoff(now);
  const longAgo = new Date(now.getTime() - 20 * 60 * 60 * 1000);
  const recently = new Date(now.getTime() - 60 * 60 * 1000);
  const digest = `sha256:${"a".repeat(64)}`;

  const names = ["quiet", "recent", "raced", "sealed"] as const;
  type Name = (typeof names)[number];
  const ids = Object.fromEntries(
    names.map((name) => [
      name,
      {
        run: crypto.randomUUID(),
        attempt: crypto.randomUUID(),
        publicId: `arun_${crypto.randomUUID().replaceAll("-", "").slice(0, 22)}`,
      },
    ]),
  ) as Record<Name, { run: string; attempt: string; publicId: string }>;
  const runIds = names.map((name) => ids[name].run);

  // The seal writes its archive segment before the seal row; an in-memory
  // archive keeps the test off the blob store.
  const segments = new Map<string, Uint8Array>();
  const archive: RunArchiveStore = {
    putSegment: async ({ digest: key, bytes }) => {
      segments.set(key, bytes);
      return { ref: `test/${key}` };
    },
    getSegment: async (ref) => {
      const bytes = segments.get(ref.replace(/^test\//, ""));
      if (!bytes) throw new Error(`no segment at ${ref}`);
      return bytes;
    },
  };
  const store = createPostgresRunStore({ archive });
  const scoped = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);

  const scan = async () =>
    (await listIdleLedgerAttempts({ cutoff, limit: 10_000 })).filter(
      (attempt) => attempt.orgId === scope.orgId,
    );
  const scanned = async (name: Name): Promise<IdleLedgerAttempt> => {
    const found = (await scan()).find((a) => a.attemptId === ids[name].attempt);
    if (!found) throw new Error(`the scan did not find ${name}`);
    return found;
  };
  const runRow = async (name: Name) =>
    (
      await withSystemDb((tx) =>
        tx
          .select()
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.id, ids[name].run))
          .limit(1),
      )
    )[0];
  const sealRow = async (name: Name) =>
    (
      await withSystemDb((tx) =>
        tx
          .select()
          .from(schema.agentRunAttemptSeals)
          .where(eq(schema.agentRunAttemptSeals.attemptId, ids[name].attempt))
          .limit(1),
      )
    )[0];

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      for (const name of names) {
        const claimedAt = name === "recent" ? recently : longAgo;
        await tx.insert(schema.agentRuns).values({
          id: ids[name].run,
          publicId: ids[name].publicId,
          ...scope,
          surface: "external",
          status: "running",
          spec: {},
          specVersion: 2,
          runKind: "general",
          specDigest: digest,
          initiatingPrincipalId: crypto.randomUUID(),
          agentPrincipalId: crypto.randomUUID(),
          agentId: crypto.randomUUID(),
          agentVersionId: crypto.randomUUID(),
          agentVersionChecksum: digest,
          authorizationSnapshotId: crypto.randomUUID(),
          retentionPolicyId: crypto.randomUUID(),
          retentionPolicyDigest: digest,
          maxAttempts: 3,
          attemptCount: 1,
          activeAttemptId: ids[name].attempt,
        });
        await tx.insert(schema.agentRunAttempts).values({
          id: ids[name].attempt,
          ...scope,
          runId: ids[name].run,
          attemptNumber: 1,
          workerId: "test-producer",
          engineName: "custom",
          engineVersion: "1",
          engineBuildDigest: digest,
          claimedAt,
        });
      }
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx
        .delete(schema.agentRunFinalizationObligations)
        .where(inArray(schema.agentRunFinalizationObligations.runId, runIds));
      await tx
        .delete(schema.agentRunFinalizationGrants)
        .where(inArray(schema.agentRunFinalizationGrants.runId, runIds));
      await tx
        .delete(schema.agentRunAttemptSeals)
        .where(inArray(schema.agentRunAttemptSeals.runId, runIds));
      await tx
        .delete(schema.agentRunEvents)
        .where(inArray(schema.agentRunEvents.runId, runIds));
      await tx
        .delete(schema.agentRunAttempts)
        .where(inArray(schema.agentRunAttempts.runId, runIds));
      await tx
        .delete(schema.agentRuns)
        .where(inArray(schema.agentRuns.id, runIds));
    });
    await closeDatabase();
  });

  it("finds an attempt only once it has been silent past the cutoff", async () => {
    const found = (await scan()).map((a) => a.attemptId);
    expect(found).toContain(ids.quiet.attempt);
    expect(found).not.toContain(ids.recent.attempt);
    const quiet = await scanned("quiet");
    expect(quiet).toMatchObject({
      runPublicId: ids.quiet.publicId,
      lastAttemptSeq: 0,
    });
  });

  it("seals a silent attempt abandoned with an unobserved tail and fails its run", async () => {
    const closed = await closeIdleLedgerAttempt(await scanned("quiet"), store);
    expect(closed).toEqual({ runPublicId: ids.quiet.publicId, ...scope });

    const seal = await sealRow("quiet");
    expect(seal).toMatchObject({
      terminalStatus: "abandoned",
      reasonCode: "idle_timeout",
      eventCount: 0,
    });
    expect(seal?.completenessGaps).toContain("unobserved_tail");
    const run = await runRow("quiet");
    expect(run).toMatchObject({
      status: "failed",
      activeAttemptId: null,
      error: LEDGER_IDLE_CLOSE_ERROR,
    });
    expect((await scan()).map((a) => a.attemptId)).not.toContain(
      ids.quiet.attempt,
    );
  });

  it("writes nothing when the producer appended after the scan", async () => {
    const stale = await scanned("raced");
    await scoped(() =>
      store.appendAttemptBatch({
        attemptId: ids.raced.attempt,
        events: [
          {
            attemptSeq: 1,
            eventType: "tool.call_completed",
            observedAt: new Date().toISOString(),
            payload: {
              tool_call_id: "call_1",
              capability_name: "edit_repo_file",
              outcome: "completed",
              input_digest: digest,
              authorization_decision_ref: "azd_0123456789abcdef0123",
              duration_ms: 5,
            },
          },
        ],
      }),
    );
    await expect(closeIdleLedgerAttempt(stale, store)).resolves.toBeNull();
    expect(await sealRow("raced")).toBeUndefined();
    expect((await runRow("raced"))?.status).toBe("running");
  });

  it("leaves the producer's own seal alone when it sealed first", async () => {
    const stale = await scanned("sealed");
    await scoped(() =>
      store.sealAttempt({
        attemptId: ids.sealed.attempt,
        terminalStatus: "completed",
        sealerId: "test-producer",
      }),
    );
    await expect(closeIdleLedgerAttempt(stale, store)).resolves.toBeNull();
    expect(await sealRow("sealed")).toMatchObject({
      terminalStatus: "completed",
      sealerWorkerId: "test-producer",
    });
    expect((await runRow("sealed"))?.status).toBe("completed");
  });
});
