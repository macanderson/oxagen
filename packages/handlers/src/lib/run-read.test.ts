/**
 * The handlers' ledger wiring (`ledgerStore`, `defaultRunReadDeps`) against
 * a run whose attempt was compacted: the frames must come back from the
 * archive segment through the process-wide evidence store, resolved at the
 * read and never at construction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  storage: vi.fn(),
  objectGet: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

// The storage driver behind the process-wide evidence store: opening it is
// the environment-bound step the deferred archive keeps out of construction.
vi.mock("@oxagen/storage", () => ({
  storage: () => mocks.storage(),
}));

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeWithTenantDbMock } from "@oxagen/database";
import { archiveFrameOf, type SealedFrameRow } from "@oxagen/run-ledger";
import { buildArchiveSegment } from "@oxagen/tacho";
import { defaultRunReadDeps, readFrames, type ResolvedRun } from "./run-read";

const UUID_RUN = "33333333-3333-4333-8333-333333333333";
const UUID_ATTEMPT = "44444444-4444-4444-8444-444444444444";
const SHA_1 = `sha256:${"1".repeat(64)}`;
const SHA_2 = `sha256:${"2".repeat(64)}`;

function sealedRow(runSeq: string, eventDigest: string): SealedFrameRow {
  return {
    id: `0192d4a8-7c1e-7a00-8000-00000000000${runSeq}`,
    attempt_seq: Number(runSeq),
    run_seq: runSeq,
    event_schema_version: "2",
    event_type: "tool.call_completed",
    stage: "tool",
    payload_digest: SHA_1,
    event_digest: eventDigest,
    payload_inline: { tool_call_id: `call_${runSeq}` },
    encrypted_payload_ref: null,
    observed_at: "2026-09-11T10:00:00.000Z",
    created_at: "2026-09-11T10:00:00.500Z",
    body_ref: null,
    body_digest: null,
    body_bytes: null,
    redactions: null,
    fidelity: "digest_only",
  };
}

const run: ResolvedRun = {
  source: "ledger",
  runId: UUID_RUN,
  row: {} as never,
  record: {} as never,
  item: {} as never,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("defaultRunReadDeps: a compacted attempt", () => {
  it("reads the frames back from the archive segment through the evidence store", async () => {
    const segment = buildArchiveSegment(
      [sealedRow("1", SHA_1), sealedRow("2", SHA_2)].map(archiveFrameOf),
    );
    const ref = `evidence/segment/${segment.segmentDigest.slice(7)}`;
    mocks.objectGet.mockResolvedValue({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(segment.bytes);
          controller.close();
        },
      }),
      contentType: "application/octet-stream",
      sizeBytes: segment.bytes.byteLength,
    });
    mocks.storage.mockReturnValue({ driver: "fake", get: mocks.objectGet });
    const dialect = new PgDialect();
    const execute = vi.fn((query: SQL) => {
      // The compacted-seals query is the one that names seals with no hot
      // rows left; the hot read answers nothing.
      if (dialect.sqlToQuery(query).sql.includes("NOT EXISTS")) {
        return Promise.resolve([
          {
            attempt_id: UUID_ATTEMPT,
            attempt_public_id: "arat_0123456789abcdefghjkmn",
            archive_segment_ref: ref,
            final_run_seq: "2",
          },
        ]);
      }
      return Promise.resolve([]);
    });
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock({ execute }));

    // The store is built before the storage driver is opened.
    const deps = defaultRunReadDeps();
    expect(mocks.storage).not.toHaveBeenCalled();

    const frames = await readFrames(deps, run, "0", 10);
    expect(mocks.objectGet).toHaveBeenCalledWith(ref);
    expect(frames.map((f) => [f.seq, f.type, f.digest])).toEqual([
      ["1", "tool.call_completed", SHA_1],
      ["2", "tool.call_completed", SHA_2],
    ]);
  });
});
