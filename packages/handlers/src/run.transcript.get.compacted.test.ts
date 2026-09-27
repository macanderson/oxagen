/**
 * `get_run_transcript` over a compacted run (spec §13.3, #4000). Compaction
 * deletes an attempt's hot frames, and the ledger store then reads them back
 * from the archive segment the seal wrote. The transcript must fold the same
 * entries and count the same figures either way: a reader cannot tell a
 * compacted run from a hot one by what the transcript says, only by the
 * run's `compacted` fact.
 *
 * The hot read is the in-memory log. The compacted read is the real ledger
 * store over a database that holds no hot row and one compacted seal, and an
 * archive that holds the segment.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086), as every suite here does.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { makeWithTenantDbMock } from "@oxagen/database";
import { runTranscriptGet } from "@oxagen/oxagen/contracts/run.transcript.get";
import {
  type AttemptEventReadRow,
  archiveFrameOf,
  createPostgresRunStore,
  mapAttemptEventReadRow,
} from "@oxagen/run-ledger";
import { buildArchiveSegment } from "@oxagen/tacho";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  createRunTranscriptGetHandler,
  type RunTranscriptGetDeps,
} from "./run.transcript.get";
import {
  ctx,
  ledgerRun,
  memoryEvents,
  memoryStores,
  memoryTachoFrames,
  summary,
} from "./run.test-support";

const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const SESSION_UUID = "0192d4a8-7c1e-7a00-8000-00000000c0de";
const ATTEMPT_ID = "0192d4a8-7c1e-7a00-8000-0000000000b1";
const ATTEMPT_PUBLIC_ID = "arat_0123456789abcdefghjkmn";
const digest = (c: string) => `sha256:${c.repeat(64)}`;

/** Two tool calls that overlap, and the terminal event, as the log holds them. */
function logRows(): AttemptEventReadRow[] {
  const frames: Array<[string, string, Record<string, unknown>]> = [
    [
      "tool.engine_call_started",
      "tool",
      { tool_call_id: "tc_a", tool_name: "a", input_digest: digest("a") },
    ],
    [
      "tool.engine_call_started",
      "tool",
      { tool_call_id: "tc_b", tool_name: "b", input_digest: digest("b") },
    ],
    [
      "tool.engine_call_completed",
      "tool",
      {
        tool_call_id: "tc_a",
        tool_name: "a",
        outcome: "completed",
        input_digest: digest("a"),
        duration_ms: 4,
      },
    ],
    [
      "tool.engine_call_completed",
      "tool",
      {
        tool_call_id: "tc_b",
        tool_name: "b",
        outcome: "failed",
        input_digest: digest("b"),
        duration_ms: 9,
      },
    ],
    [
      "terminal.attempt_terminated",
      "terminal",
      { terminal_status: "completed" },
    ],
  ];
  return frames.map(([eventType, stage, payload], i) => ({
    id: `0192d4a8-7c1e-7a00-8000-0000000000e${i + 1}`,
    attempt_id: ATTEMPT_ID,
    attempt_public_id: ATTEMPT_PUBLIC_ID,
    run_seq: String(i + 1),
    attempt_seq: i + 1,
    event_schema_version: "1",
    event_type: eventType,
    stage,
    payload_digest: digest(String(i + 1)),
    event_digest: digest(String.fromCharCode(97 + i)),
    payload_inline: payload,
    encrypted_payload_ref: null,
    observed_at: `2026-09-11T10:00:0${i + 1}.000Z`,
    created_at: `2026-09-11T10:00:0${i + 1}.500Z`,
    body_ref: null,
    body_digest: null,
    body_bytes: null,
    redactions: null,
    fidelity: "digest_only",
  }));
}

function depsOver(
  readAttemptEventsSince: RunTranscriptGetDeps["store"]["readAttemptEventsSince"],
): RunTranscriptGetDeps {
  const stores = memoryStores(
    [ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID })],
    [],
  );
  return {
    queries: stores.queries,
    store: {
      getRunByPublicId: (id) =>
        Promise.resolve(id === LEDGER_ID ? summary() : null),
      readAttemptEventsSince,
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: memoryTachoFrames(SESSION_UUID, []),
    bodies: {
      getBody: () => Promise.reject(new Error("no bodies in this test")),
      getAssembly: () => Promise.resolve(null),
    },
    priceBook: () => Promise.resolve([]),
  };
}

/** The ledger store over a database that compacted the attempt. */
function compactedStore(rows: readonly AttemptEventReadRow[]) {
  const segment = buildArchiveSegment(rows.map(archiveFrameOf));
  const ref = `evidence/segment/${segment.segmentDigest.slice(7)}`;
  const getSegment = vi.fn((asked: string) =>
    asked === ref
      ? Promise.resolve(segment.bytes)
      : Promise.reject(new Error(`no segment at ${asked}`)),
  );
  const dialect = new PgDialect();
  const execute = vi.fn((query: SQL) => {
    // The compacted-seals query names seals with no hot rows left. Every
    // other read is the hot log, which compaction emptied.
    if (dialect.sqlToQuery(query).sql.includes("NOT EXISTS")) {
      return Promise.resolve([
        {
          attempt_id: ATTEMPT_ID,
          attempt_public_id: ATTEMPT_PUBLIC_ID,
          archive_segment_ref: ref,
          final_run_seq: String(rows.length),
        },
      ]);
    }
    return Promise.resolve([]);
  });
  mocks.withTenantDb.mockImplementation(makeWithTenantDbMock({ execute }));
  const store = createPostgresRunStore({
    archive: {
      getSegment,
      putSegment: () => Promise.reject(new Error("a read never seals")),
    },
  });
  return { store, getSegment };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("get_run_transcript over a compacted run", () => {
  it("restores from the segment exactly the records the hot log held", async () => {
    const rows = logRows();
    const { store, getSegment } = compactedStore(rows);
    const restored = await store.readAttemptEventsSince(RUN_UUID, "0", 50);
    expect(getSegment).toHaveBeenCalledTimes(1);
    expect(restored).toEqual(rows.map(mapAttemptEventReadRow));
  });

  it.each(["turns", "steps", "everything"] as const)(
    "folds the same entries and counts at %s zoom from the segment as from the hot rows",
    async (zoom) => {
      const rows = logRows();
      const request = runTranscriptGet.input.parse({ runId: LEDGER_ID, zoom });
      const hot = await createRunTranscriptGetHandler(
        depsOver(memoryEvents(rows.map(mapAttemptEventReadRow))),
      )(request, ctx());

      const { store, getSegment } = compactedStore(rows);
      const compacted = await createRunTranscriptGetHandler(
        depsOver((runId, after, limit) =>
          store.readAttemptEventsSince(runId, after, limit),
        ),
      )(request, ctx());

      expect(getSegment).toHaveBeenCalled();
      expect(runTranscriptGet.output.parse(compacted)).toEqual(compacted);
      expect(compacted.entries.length).toBeGreaterThan(0);
      expect(compacted).toEqual(hot);
    },
  );

  it("pages a compacted run to its end the way it pages a hot one", async () => {
    const rows = logRows();
    const request = (after?: string) =>
      runTranscriptGet.input.parse({
        runId: LEDGER_ID,
        zoom: "steps",
        limit: 1,
        ...(after === undefined ? {} : { after }),
      });
    const walk = async (deps: RunTranscriptGetDeps) => {
      const handler = createRunTranscriptGetHandler(deps);
      const pages: Array<Array<[string, string]>> = [];
      let after: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await handler(request(after), ctx());
        pages.push(page.entries.map((e) => [e.seq, e.endSeq]));
        if (page.cursor === null) break;
        after = page.cursor;
      }
      return pages;
    };
    const hot = await walk(
      depsOver(memoryEvents(rows.map(mapAttemptEventReadRow))),
    );
    const { store } = compactedStore(rows);
    const compacted = await walk(
      depsOver((runId, after, limit) =>
        store.readAttemptEventsSince(runId, after, limit),
      ),
    );
    expect(hot.length).toBeGreaterThan(1);
    expect(compacted).toEqual(hot);
  });
});
