/**
 * run-record: the tenant read path the export and summarize jobs share.
 * Every read runs inside the run's tenant scope; the wrapped-session select
 * fences on the public id, the org and the workspace; an unsegmented ledger
 * seal refuses to export.
 */
import { schema } from "@oxagen/database";
import type { TachoFrameRow } from "@oxagen/telemetry";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  createPostgresRunStore: vi.fn(),
  getSegment: vi.fn(),
  selectTachoEvents: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/database")>()),
  withTenantDb: mocks.withTenantDb,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));
vi.mock("@oxagen/run-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/run-ledger")>()),
  createPostgresRunStore: mocks.createPostgresRunStore,
}));
vi.mock("@oxagen/run-ledger/evidence-store", () => ({
  evidenceStore: () => ({ getSegment: mocks.getSegment }),
}));
vi.mock("@oxagen/telemetry", () => ({
  selectTachoEvents: mocks.selectTachoEvents,
}));

import {
  readRunFrames,
  readSealedSegments,
  resolveRunRecord,
} from "./run-record";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-0000000000a1",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000b1",
};
const OTHER_WORKSPACE = "0192d4a8-7c1e-7a00-8000-0000000000b2";
const SESSION = "0192d4a8-7c1e-7a00-8000-00000000c0de";

function tachoRow(seq: number): TachoFrameRow {
  return {
    seq,
    ts: "2026-09-11 09:00:00.000",
    eventId: `evt_${String(seq).padStart(26, "0")}`,
    kind: "tool_call",
    prevHash: `sha256:${String(Math.max(seq - 1, 0)).padStart(64, "0")}`,
    hash: `sha256:${String(seq).padStart(64, "0")}`,
    contentDigest: "",
    bytesRef: "",
    redactions: "",
    body: "{}",
    toolName: "Read",
    toolStatus: "ok",
    toolUseId: `tu_${seq}`,
    model: "",
    provider: "",
    policyDecision: "",
    costUsdMicros: null,
    turnSeq: null,
  } as TachoFrameRow;
}

const scopes: unknown[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  scopes.length = 0;
  mocks.runInTenantScope.mockImplementation(
    (scope: unknown, fn: () => unknown) => {
      scopes.push(scope);
      return fn();
    },
  );
});

describe("resolveRunRecord", () => {
  const db = drizzle.mock({ schema });

  /** Answers `rows` for the select, recording the SQL it compiled. */
  function selectAnswering(rows: unknown[]) {
    const compiled: Array<{ sql: string; params: unknown[] }> = [];
    mocks.withTenantDb.mockImplementation(
      (
        fn: (tx: unknown) => { toSQL(): { sql: string; params: unknown[] } },
      ) => {
        compiled.push(fn(db).toSQL());
        return Promise.resolve(rows);
      },
    );
    return compiled;
  }

  it("reads a wrapped session inside the tenant scope, fenced on public id, org and workspace", async () => {
    const compiled = selectAnswering([
      {
        sessionUuid: SESSION,
        enforcementTier: "gateway",
        completenessGaps: ["tool_bodies", 3],
        replayGrade: "view",
      },
    ]);
    const record = await resolveRunRecord(SCOPE, "tse_4q8r1t6v3x5z0b2d7h2k9m");
    expect(record).toEqual({
      source: "tacho",
      sessionUuid: SESSION,
      enforcementTier: "gateway",
      completenessGaps: ["tool_bodies"],
      replayGrade: "view",
    });
    expect(scopes).toEqual([SCOPE]);
    const [query] = compiled;
    expect(query?.sql).toMatch(/"sessions"\."public_id" = \$\d+/);
    expect(query?.sql).toMatch(/"sessions"\."org_id" = \$\d+/);
    expect(query?.sql).toMatch(/"sessions"\."workspace_id" = \$\d+/);
    expect(query?.params).toEqual(
      expect.arrayContaining([
        "tse_4q8r1t6v3x5z0b2d7h2k9m",
        SCOPE.orgId,
        SCOPE.workspaceId,
      ]),
    );
  });

  it("answers null for a session the select does not find in another workspace (negative)", async () => {
    const compiled = selectAnswering([]);
    const other = { ...SCOPE, workspaceId: OTHER_WORKSPACE };
    expect(await resolveRunRecord(other, "tse_4q8r1t6v3x5z0b2d7h2k9m")).toBe(
      null,
    );
    expect(compiled[0]?.params).toContain(OTHER_WORKSPACE);
    expect(compiled[0]?.params).not.toContain(SCOPE.workspaceId);
  });

  it("reads a ledger run through the ledger store inside the scope, and answers null when the store has none (negative)", async () => {
    const attempts = [{ attemptId: "a1" }];
    mocks.createPostgresRunStore.mockReturnValue({
      getRunByPublicId: (id: string) =>
        Promise.resolve(id === "arun_known" ? { runId: "r1" } : null),
      listRunAttempts: () => Promise.resolve(attempts),
    });
    expect(await resolveRunRecord(SCOPE, "arun_known")).toEqual({
      source: "ledger",
      runId: "r1",
      attempts,
    });
    expect(await resolveRunRecord(SCOPE, "arun_unknown")).toBe(null);
    expect(scopes).toEqual([SCOPE, SCOPE]);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});

describe("readSealedSegments", () => {
  it("refuses a ledger seal the recorder never segmented (negative)", async () => {
    const record = {
      source: "ledger" as const,
      runId: "r1",
      attempts: [
        {
          attemptId: "a1",
          attemptPublicId: "arat_0123456789abcdefghjkmn",
          attemptNumber: 1,
          seal: { archiveSegmentRef: null, merkleRoot: null },
        },
      ],
    } as unknown as Parameters<typeof readSealedSegments>[1];
    await expect(readSealedSegments(SCOPE, record)).rejects.toThrow(
      /arat_0123456789abcdefghjkmn sealed before the recorder graded it/,
    );
    expect(mocks.getSegment).not.toHaveBeenCalled();
    expect(scopes).toEqual([SCOPE]);
  });

  it("builds a wrapped session's one segment from every row, paging past the first 500", async () => {
    const rows = Array.from({ length: 501 }, (_, i) => tachoRow(i));
    mocks.selectTachoEvents.mockImplementation(
      ({ afterSeq, limit }: { afterSeq: number; limit: number }) =>
        Promise.resolve(rows.filter((r) => r.seq > afterSeq).slice(0, limit)),
    );
    const [segment] = await readSealedSegments(SCOPE, {
      source: "tacho",
      sessionUuid: SESSION,
      enforcementTier: "gateway",
      completenessGaps: [],
      replayGrade: "view",
    });
    expect(segment?.frameCount).toBe(501);
    expect(segment?.digests.at(-1)).toBe(rows[500]?.hash);
    expect(
      mocks.selectTachoEvents.mock.calls.map((c) => c[0].afterSeq),
    ).toEqual([-1, 499]);
    expect(
      mocks.selectTachoEvents.mock.calls.every(
        (c) => c[0].sessionUuid === SESSION,
      ),
    ).toBe(true);
  });
});

describe("readRunFrames", () => {
  it("reads a wrapped session's frames in sequence inside the tenant scope", async () => {
    mocks.selectTachoEvents.mockResolvedValue([tachoRow(0), tachoRow(1)]);
    const frames = await readRunFrames(SCOPE, {
      source: "tacho",
      sessionUuid: SESSION,
      enforcementTier: "harness",
      completenessGaps: [],
      replayGrade: null,
    });
    expect(frames.map((f) => f.seq)).toEqual(["0", "1"]);
    expect(scopes).toEqual([SCOPE]);
  });
});
