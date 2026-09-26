/**
 * fork_run. The org is tier-free in every case, so every refusal below comes
 * from the handler (ARCHITECTURE.md §3.2, INV-29). The `fork`-graded ledger
 * seal these tests use is a state no recorder in this revision writes
 * (ADR-058 decision 3): the mint waits for the gateway-observed ledger lane.
 */
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { runFork } from "@oxagen/oxagen/contracts/run.fork";
import type { AttemptEventReadRecord, AttemptRecord } from "@oxagen/run-ledger";
import {
  RunNotWritableError,
  RunStoreStateError,
} from "@oxagen/run-ledger/run-errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { createRunForkHandler, type RunForkDeps } from "./run.fork";
import {
  ctx,
  event,
  keyCtx,
  ledgerRun,
  memoryEvents,
  memoryStores,
  memoryTachoFrames,
  roleTx,
  summary,
  tachoSession,
} from "./run.test-support";

const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const DIGEST = `sha256:${"a".repeat(64)}`;

const retained = {
  bodyRef: `evb:v1:k:${"a".repeat(64)}`,
  bodyDigest: DIGEST,
  bodyBytes: 4,
  redactions: [],
  fidelity: "full" as const,
};

function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    attemptId: "0192d4a8-7c1e-7a00-8000-0000000000b1",
    attemptPublicId: "arat_0123456789abcdefghjkmn",
    runId: RUN_UUID,
    attemptNumber: 1,
    producerId: "drain_1",
    engine: { name: "stella", version: "2.1.0", buildDigest: DIGEST },
    resumedFrom: null,
    forkedFromRunSeq: null,
    claimedAt: new Date("2026-09-11T10:00:01.000Z"),
    seal: {
      sealId: "s1",
      terminalStatus: "completed",
      reasonCode: null,
      eventCount: 3,
      finalRunSeq: "3",
      finalAttemptSeq: 3,
      finalEventDigest: DIGEST,
      eventStreamDigest: DIGEST,
      sealedAt: new Date("2026-09-11T10:05:00.000Z"),
      replayGrade: "fork",
      completenessGaps: [],
      merkleRoot: DIGEST,
      archiveSegmentRef: "evidence/o/w/segments/a/x.ndjson.zst",
      modelCalls: 1,
      toolCalls: 1,
      turns: 1,
      // A gateway-observed recording is the only one that reaches `fork`
      // (spec §8.4); a submitted one is `harness` and caps at `view`.
      enforcementTier: "gateway",
      archiveSegmentDigest: DIGEST,
      attestationKeyId: null,
      attestationSig: null,
    },
    ...over,
  };
}

function harness(over: {
  role?: string | null;
  keyCreator?: string | null;
  attempts?: AttemptRecord[];
  events?: AttemptEventReadRecord[];
}) {
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn(
        roleTx(over.role === undefined ? "Member" : over.role, over.keyCreator),
      ),
    ),
  );
  const stores = memoryStores(
    [ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID })],
    [tachoSession({ publicId: TACHO_ID, session: { replayGrade: "fork" } })],
  );
  const createAttempt = vi.fn(
    (input: Parameters<RunForkDeps["attempts"]["createAttempt"]>[0]) =>
      Promise.resolve({
        attemptId: "0192d4a8-7c1e-7a00-8000-0000000000b2",
        attemptPublicId: "arat_forkforkforkforkforkfo",
        runId: input.runId,
        orgId: ctx().orgId,
        workspaceId: ctx().workspaceId,
        attemptNumber: 2,
        maxAttempts: 3,
        engine: input.engine,
        resumedFrom: input.resumedFrom ?? null,
        forkedFromRunSeq: input.forkedFromRunSeq ?? null,
      }),
  );
  const deps: RunForkDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: (id) =>
        Promise.resolve(id === LEDGER_ID ? summary() : null),
      readAttemptEventsSince: memoryEvents(
        over.events ?? [1, 2, 3].map((n) => event(n, { body: retained })),
      ),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: memoryTachoFrames("none", []),
    attempts: {
      listRunAttempts: () => Promise.resolve(over.attempts ?? [attempt()]),
      createAttempt,
    },
  };
  return { fork: createRunForkHandler(deps), createAttempt };
}

const conflict = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "conflict" && e.reason === reason;
const refused = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "forbidden" && e.reason === reason;

describe("fork_run", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses a wrapped session by name even when its seal recorded fork (negative)", async () => {
    const { fork, createAttempt } = harness({});
    await expect(
      fork({ runId: TACHO_ID, fromSeq: "1" }, ctx()),
    ).rejects.toSatisfy(conflict("fork_requires_ledger_run"));
    expect(createAttempt).not.toHaveBeenCalled();
    expect(
      runFork.input.safeParse({ runId: TACHO_ID, fromSeq: "1" }).success,
    ).toBe(true);
  });

  it("refuses a Viewer and a user with no org role, before any read (negative)", async () => {
    for (const role of ["Viewer", null]) {
      const { fork, createAttempt } = harness({ role });
      await expect(
        fork({ runId: LEDGER_ID, fromSeq: "1" }, ctx()),
      ).rejects.toSatisfy((e) => isHandlerError(e) && e.code === "forbidden");
      expect(createAttempt).not.toHaveBeenCalled();
    }
  });

  describe("an API-key call acts as the key's creator", () => {
    it("mints the attempt for a creator who is an org Member", async () => {
      const { fork, createAttempt } = harness({ role: "Member" });
      await expect(
        fork({ runId: LEDGER_ID, fromSeq: "2" }, keyCtx()),
      ).resolves.toMatchObject({ attemptNumber: 2 });
      expect(createAttempt).toHaveBeenCalledOnce();
    });

    it("refuses a key whose creator is an org Viewer (negative)", async () => {
      const { fork, createAttempt } = harness({ role: "Viewer" });
      await expect(
        fork({ runId: LEDGER_ID, fromSeq: "2" }, keyCtx()),
      ).rejects.toSatisfy(refused("org_role_required"));
      expect(createAttempt).not.toHaveBeenCalled();
    });

    it("refuses a key with no creator (negative)", async () => {
      const { fork, createAttempt } = harness({
        role: "Owner",
        keyCreator: null,
      });
      await expect(
        fork({ runId: LEDGER_ID, fromSeq: "2" }, keyCtx()),
      ).rejects.toSatisfy(refused("no_principal"));
      expect(createAttempt).not.toHaveBeenCalled();
    });
  });

  it("refuses a run whose recorded grade is below fork, and one the recorder never graded (negative)", async () => {
    for (const replayGrade of ["inspect", "view", null]) {
      const { fork, createAttempt } = harness({
        attempts: [
          attempt({
            seal: {
              ...(attempt().seal as NonNullable<AttemptRecord["seal"]>),
              replayGrade,
            },
          }),
        ],
      });
      await expect(
        fork({ runId: LEDGER_ID, fromSeq: "1" }, ctx()),
      ).rejects.toSatisfy(conflict("replay_grade_below_fork"));
      expect(createAttempt).not.toHaveBeenCalled();
    }
  });

  it("refuses a branch point a bodiless frame precedes (negative)", async () => {
    const { fork, createAttempt } = harness({
      events: [
        event(1, { body: retained }),
        event(2, {
          body: { ...retained, bodyRef: null, fidelity: "digest_only" },
        }),
        event(3, { body: retained }),
      ],
    });
    await expect(
      fork({ runId: LEDGER_ID, fromSeq: "3" }, ctx()),
    ).rejects.toSatisfy(conflict("gap_before_from_seq"));
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it("mints an attempt that branches from the sealed attempt at the branch point", async () => {
    // Frame 1 carries no content; frame 3, past the branch point, kept no body.
    const { fork, createAttempt } = harness({
      events: [
        event(1, { eventType: "run.started" }),
        event(2, { body: retained }),
        event(3),
      ],
    });
    await expect(
      fork({ runId: LEDGER_ID, fromSeq: "2" }, ctx()),
    ).resolves.toEqual({
      attemptId: "arat_forkforkforkforkforkfo",
      attemptNumber: 2,
    });
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledWith({
      runId: RUN_UUID,
      producerId: "drain_1",
      engine: { name: "stella", version: "2.1.0", buildDigest: DIGEST },
      resumedFrom: {
        attemptId: "0192d4a8-7c1e-7a00-8000-0000000000b1",
        attemptPublicId: "arat_0123456789abcdefghjkmn",
      },
      forkedFromRunSeq: "2",
    });
  });

  it("refuses a branch point a content-bearing frame with no digest and no body precedes (negative)", async () => {
    const { fork, createAttempt } = harness({
      events: [
        event(1, { body: retained }),
        event(2),
        event(3, { body: retained }),
      ],
    });
    await expect(
      fork({ runId: LEDGER_ID, fromSeq: "3" }, ctx()),
    ).rejects.toSatisfy(conflict("gap_before_from_seq"));
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it("refuses a branch point past the seal, and a run with no sealed attempt (negative)", async () => {
    const past = harness({});
    await expect(
      past.fork({ runId: LEDGER_ID, fromSeq: "4" }, ctx()),
    ).rejects.toSatisfy(conflict("from_seq_past_seal"));
    const open = harness({ attempts: [attempt({ seal: null })] });
    await expect(
      open.fork({ runId: LEDGER_ID, fromSeq: "1" }, ctx()),
    ).rejects.toSatisfy(conflict("run_not_sealed"));
  });

  it("answers conflict when a cancel or a pause wins the run lock (negative)", async () => {
    for (const reason of ["cancelled", "paused"] as const) {
      const { fork, createAttempt } = harness({});
      createAttempt.mockRejectedValueOnce(
        new RunNotWritableError(RUN_UUID, reason, `run ${RUN_UUID} ${reason}`),
      );
      await expect(
        fork({ runId: LEDGER_ID, fromSeq: "2" }, ctx()),
      ).rejects.toSatisfy(conflict("run_not_writable"));
    }
  });

  it("answers conflict when the run holds its pinned max_attempts (negative)", async () => {
    const { fork, createAttempt } = harness({});
    createAttempt.mockRejectedValueOnce(
      new RunNotWritableError(RUN_UUID, "attempts_exhausted", "max 3"),
    );
    await expect(
      fork({ runId: LEDGER_ID, fromSeq: "2" }, ctx()),
    ).rejects.toSatisfy(conflict("run_attempts_exhausted"));
  });

  it("rethrows a store fault unchanged, so it stays a 500", async () => {
    const { fork, createAttempt } = harness({});
    const fault = new RunStoreStateError("attempt insert returned no row");
    createAttempt.mockRejectedValueOnce(fault);
    await expect(fork({ runId: LEDGER_ID, fromSeq: "2" }, ctx())).rejects.toBe(
      fault,
    );
  });

  it("is not_found for a run outside the workspace (negative)", async () => {
    const { fork } = harness({});
    await expect(
      fork({ runId: "arun_nope", fromSeq: "1" }, ctx()),
    ).rejects.toSatisfy((e) => isHandlerError(e) && e.code === "not_found");
  });
});
