// The assistant-run sweep against a real Postgres (#3988): the scan finds an
// open assistant run only once it has shown no life since the cutoff, the
// close seals it abandoned and fails the run, a close that lost a race to an
// append writes nothing, a second close is a no-op, and the abandoned
// attempt refuses a late append. Runs wherever DATABASE_URL points at a
// migrated database (CI's `test` job). A local run without one is skipped,
// not red. Every row it writes is removed in afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import {
  createPostgresRunStore,
  type RunArchiveStore,
} from "@oxagen/run-ledger";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ABANDON_SEALER_ID,
  ABANDONED_REASON_CODE,
  abandonSilentRun,
  listSilentAssistantRuns,
  type SilentAssistantRun,
} from "./assistant-run-abandon";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("the assistant-run sweep against Postgres", () => {
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const digest = `sha256:${"a".repeat(64)}`;
  const names = [
    "quiet",
    "raced",
    "twice",
    "unattempted",
    "live",
    "external",
    "finished",
  ] as const;
  type Name = (typeof names)[number];
  const runIds = Object.fromEntries(
    names.map((name) => [name, crypto.randomUUID()]),
  ) as Record<Name, string>;
  const attemptIds = Object.fromEntries(
    names.map((name) => [name, crypto.randomUUID()]),
  ) as Record<Name, string>;
  const publicId = (name: Name) =>
    `arun_${runIds[name].replaceAll("-", "").slice(0, 22)}`;

  const segments = new Map<string, Uint8Array>();
  const archive: RunArchiveStore = {
    putSegment: async (input) => {
      const ref = `evidence/segment/${input.digest.slice(7)}`;
      segments.set(ref, input.bytes);
      return { ref };
    },
    getSegment: async (ref) => {
      const bytes = segments.get(ref);
      if (!bytes) throw new Error(`no segment at ${ref}`);
      return bytes;
    },
  };
  const store = createPostgresRunStore({ archive });
  const scoped = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);

  const toolEvent = (attemptSeq: number) => ({
    attemptSeq,
    eventType: "tool.call_completed",
    observedAt: new Date().toISOString(),
    payload: {
      tool_call_id: `call_${attemptSeq}`,
      capability_name: "list_runs",
      outcome: "completed" as const,
      input_digest: digest,
      authorization_decision_ref: "azd_0123456789abcdef0123",
      duration_ms: 5,
    },
  });
  const append = (name: Name, attemptSeq: number) =>
    scoped(() =>
      store.appendAttemptBatch({
        attemptId: attemptIds[name],
        events: [toolEvent(attemptSeq)],
      }),
    );

  const runRow = (
    name: Name,
    over: { surface?: string; status?: string } = {},
  ) => ({
    id: runIds[name],
    publicId: publicId(name),
    ...scope,
    surface: over.surface ?? "chat",
    status: over.status ?? "running",
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
    maxAttempts: 1,
  });

  let cutoff: Date;
  let found: Map<string, SilentAssistantRun>;

  const readRun = (name: Name) =>
    withSystemDb((tx) =>
      tx
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, runIds[name]))
        .limit(1),
    ).then((rows) => rows[0]);
  const readSeals = (name: Name) =>
    withSystemDb((tx) =>
      tx
        .select()
        .from(schema.agentRunAttemptSeals)
        .where(eq(schema.agentRunAttemptSeals.runId, runIds[name])),
    );
  const scan = async () =>
    new Map(
      (await listSilentAssistantRuns({ cutoff, limit: 10_000 }))
        .filter((run) => run.orgId === scope.orgId)
        .map((run) => [run.publicId, run]),
    );

  beforeAll(async () => {
    const opened: Name[] = [
      "quiet",
      "raced",
      "twice",
      "live",
      "external",
      "finished",
    ];
    await withSystemDb(async (tx) => {
      await tx.insert(schema.agentRuns).values([
        runRow("quiet"),
        runRow("raced"),
        runRow("twice"),
        runRow("unattempted", { status: "pending" }),
        runRow("live"),
        runRow("external", { surface: "external" }),
        runRow("finished", { status: "completed" }),
      ]);
      await tx.insert(schema.agentRunAttempts).values(
        opened.map((name) => ({
          id: attemptIds[name],
          ...scope,
          runId: runIds[name],
          attemptNumber: 1,
          workerId: "oxagen.assistant",
          engineName: "stella",
          engineVersion: "0.9.411",
          engineBuildDigest: digest,
        })),
      );
      for (const name of opened) {
        await tx
          .update(schema.agentRuns)
          .set({ activeAttemptId: attemptIds[name], attemptCount: 1 })
          .where(eq(schema.agentRuns.id, runIds[name]));
      }
    });
    await append("quiet", 1);
    await append("raced", 1);
    await append("external", 1);
    // The cutoff is the database's clock after every silent row landed, so
    // a frame written after it is life the scan must see. The pauses keep
    // both sides clear of the millisecond a JavaScript Date keeps.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [now] = await withSystemDb((tx) =>
      tx.execute(sql`select clock_timestamp()::text as at`),
    ).then((rows) => rows as unknown as Array<{ at: string }>);
    cutoff = new Date(now!.at);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await append("live", 1);
    found = await scan();
  });

  afterAll(async () => {
    const ids = Object.values(runIds);
    await withSystemDb(async (tx) => {
      await tx
        .delete(schema.agentRunFinalizationObligations)
        .where(inArray(schema.agentRunFinalizationObligations.runId, ids));
      await tx
        .delete(schema.agentRunFinalizationGrants)
        .where(inArray(schema.agentRunFinalizationGrants.runId, ids));
      await tx
        .delete(schema.agentRunAttemptSeals)
        .where(inArray(schema.agentRunAttemptSeals.runId, ids));
      await tx
        .delete(schema.agentRunEvents)
        .where(inArray(schema.agentRunEvents.runId, ids));
      await tx
        .update(schema.agentRuns)
        .set({ activeAttemptId: null })
        .where(inArray(schema.agentRuns.id, ids));
      await tx
        .delete(schema.agentRunAttempts)
        .where(inArray(schema.agentRunAttempts.runId, ids));
      await tx
        .delete(schema.agentRuns)
        .where(inArray(schema.agentRuns.id, ids));
    });
    await closeDatabase();
  });

  it("finds an open assistant run only once it has shown no life since the cutoff", () => {
    expect([...found.keys()].sort()).toEqual(
      [
        publicId("quiet"),
        publicId("raced"),
        publicId("twice"),
        publicId("unattempted"),
      ].sort(),
    );
    // A run that recorded a frame after the cutoff is live, whatever its age.
    expect(found.has(publicId("live"))).toBe(false);
    expect(found.get(publicId("quiet"))).toMatchObject({
      runId: runIds.quiet,
      attemptId: attemptIds.quiet,
      nextRunSeq: "2",
    });
    expect(found.get(publicId("unattempted"))?.attemptId).toBeNull();
  });

  it("seals an open run past the limit abandoned and fails it", async () => {
    const closed = await abandonSilentRun(found.get(publicId("quiet"))!, store);
    expect(closed?.seal).toMatchObject({
      terminalStatus: "abandoned",
      eventCount: 1,
      alreadySealed: false,
    });
    const run = await readRun("quiet");
    expect(run?.status).toBe("failed");
    expect(run?.activeAttemptId).toBeNull();
    expect(run?.completedAt).not.toBeNull();
    expect(run?.error).toContain("sealed it abandoned");
    const [seal] = await readSeals("quiet");
    expect(seal).toMatchObject({
      terminalStatus: "abandoned",
      reasonCode: ABANDONED_REASON_CODE,
      sealerWorkerId: ABANDON_SEALER_ID,
      eventCount: 1,
      finalAttemptSeq: 1,
    });
    expect(seal?.completenessGaps).toContain("unobserved_tail");
    expect(seal?.replayGrade).toBe("inspect");
  });

  it("refuses a late append and answers a late seal with the abandoned one", async () => {
    await expect(append("quiet", 2)).rejects.toMatchObject({
      code: "run_attempt_not_writable",
      reason: "sealed",
    });
    const late = await scoped(() =>
      store.sealAttempt({
        attemptId: attemptIds.quiet,
        terminalStatus: "completed",
        sealerId: "oxagen.assistant",
      }),
    );
    expect(late).toMatchObject({
      terminalStatus: "abandoned",
      alreadySealed: true,
    });
    expect(await readSeals("quiet")).toHaveLength(1);
    expect((await readRun("quiet"))?.status).toBe("failed");
  });

  it("gives way to a turn that appended after the scan read it", async () => {
    await append("raced", 2);
    expect(
      await abandonSilentRun(found.get(publicId("raced"))!, store),
    ).toBeNull();
    expect((await readRun("raced"))?.status).toBe("running");
    expect(await readSeals("raced")).toHaveLength(0);
  });

  it("seals a run swept twice once", async () => {
    const twice = found.get(publicId("twice"))!;
    const first = await abandonSilentRun(twice, store);
    expect(first?.seal).toMatchObject({
      terminalStatus: "abandoned",
      eventCount: 0,
      finalEventDigest: null,
    });
    expect(await abandonSilentRun(twice, store)).toBeNull();
    expect(await readSeals("twice")).toHaveLength(1);
  });

  it("fails a run that never got an attempt, with nothing to seal", async () => {
    const closed = await abandonSilentRun(
      found.get(publicId("unattempted"))!,
      store,
    );
    expect(closed).toEqual({ runId: runIds.unattempted, seal: null });
    expect((await readRun("unattempted"))?.status).toBe("failed");
  });

  it("leaves a live run, another producer's run and a finished run alone", async () => {
    expect((await readRun("live"))?.status).toBe("running");
    expect((await readRun("external"))?.status).toBe("running");
    expect((await readRun("finished"))?.status).toBe("completed");
    const still = await withSystemDb((tx) =>
      tx
        .select({ id: schema.agentRunAttemptSeals.id })
        .from(schema.agentRunAttemptSeals)
        .where(
          inArray(schema.agentRunAttemptSeals.runId, [
            runIds.live,
            runIds.external,
            runIds.finished,
          ]),
        ),
    );
    expect(still).toHaveLength(0);
  });
});
