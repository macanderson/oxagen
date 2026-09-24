// Times `get_run_transcript` against a real ClickHouse holding a large run.
//
// Skipped unless BENCH_CLICKHOUSE_URL names a ClickHouse whose `tacho_events`
// table holds the benchmark runs. Seed a throwaway container, never a shared
// store, with `packages/handlers/bench/seed-tacho-run.py` (its header has the
// setup), then run:
//
//   BENCH_CLICKHOUSE_URL=http://127.0.0.1:18123 BENCH_OUT=/tmp/after.json \
//     pnpm --filter @oxagen/handlers test:unit src/run.transcript.get.bench.test.ts
//
// Each case replays a read the Run page makes: the transcript's first page,
// the next page, the poll a live run's stream triggers, and the whole-run
// reads behind the Cost tab. Every case reports the median wall time over
// several runs, the ClickHouse queries it issued, and the rows and bytes
// ClickHouse read for it (from `system.query_log`). Body reads are left out:
// the seeded frames keep no bodies, so both versions pay the same zero. The
// subagent chains come from a fixed list here, so the Postgres query that
// lists them in production is not timed. A case that times out is recorded
// with its error, and the rest still run.
import { writeFileSync } from "node:fs";
import { runTranscriptGet } from "@oxagen/oxagen/contracts/run.transcript.get";
import {
  runInTenantScope,
  setDataPlaneResolver,
  clearDataPlaneResolver,
} from "@oxagen/tenancy";
import {
  closeClickhouse,
  selectTachoEvents,
  selectTachoSubagentEvents,
} from "@oxagen/telemetry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRunTranscriptGetHandler,
  type RunTranscriptGetDeps,
} from "./run.transcript.get";
import {
  ctx,
  memoryEvents,
  memoryStores,
  tachoSession,
} from "./run.test-support";

const url = process.env["BENCH_CLICKHOUSE_URL"];
const RUNS = Number(process.env["BENCH_RUNS"] ?? 5);

const SCOPE = {
  orgId: "0b0e0000-0000-4000-8000-000000000001",
  workspaceId: "0b0e0000-0000-4000-8000-000000000002",
};
/** 240,000 frames on the root chain and ten subagent chains of 1,000. */
const BIG = {
  publicId: "tse_bench250k0000000000000",
  sessionUuid: "0b0e0000-0000-4000-8000-0000000000aa",
  frames: 250_000,
};
/** The ten subagent chains the seed writes under BIG. */
const BIG_CHILDREN = Array.from(
  { length: 10 },
  (_, i) => `0b0e0000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
);
/** 25,000 frames and no subagents. */
const MID = {
  publicId: "tse_bench25k00000000000000",
  sessionUuid: "0b0e0000-0000-4000-8000-000000000200",
  frames: 25_000,
};

type Counted = { queries: number };

function handler(outcome: string, counted: Counted) {
  const stores = memoryStores(
    [],
    [BIG, MID].map((run) =>
      tachoSession({
        scope: SCOPE,
        publicId: run.publicId,
        session: {
          sessionUuid: run.sessionUuid,
          outcome,
          seqCount: run.frames,
          startedAt: new Date("2026-09-20T09:00:00.000Z"),
          sealedAt:
            outcome === "running" ? null : new Date("2026-09-21T02:00:00.000Z"),
        },
      }),
    ),
  );
  const deps: RunTranscriptGetDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: () => Promise.resolve(null),
      readAttemptEventsSince: memoryEvents([]),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: (args) => {
      counted.queries += 1;
      return selectTachoEvents(args);
    },
    tachoSubagentFrames: (args) => {
      counted.queries += 1;
      return selectTachoSubagentEvents(args);
    },
    tachoChildSessions: (root) =>
      Promise.resolve(root === BIG.sessionUuid ? BIG_CHILDREN : []),
    bodies: {
      getBody: () => Promise.reject(new Error("the benchmark keeps no bodies")),
      getAssembly: () => Promise.resolve(null),
    },
    priceBook: () => Promise.resolve([]),
  };
  return createRunTranscriptGetHandler(deps);
}

async function clickhouse(sql: string): Promise<string> {
  const res = await fetch(`${url}/?database=bench`, {
    method: "POST",
    body: sql,
    headers: { authorization: `Basic ${btoa("bench:bench")}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text;
}

/** What ClickHouse read for every `tacho_events` query since `since`. */
async function readSince(since: string) {
  await clickhouse("SYSTEM FLUSH LOGS");
  const row = await clickhouse(`
    SELECT count(), sum(read_rows), sum(read_bytes), max(memory_usage)
    FROM system.query_log
    WHERE type = 'QueryFinish' AND event_time_microseconds >= '${since}'
      AND query LIKE '%tacho_events%' AND query NOT LIKE '%query_log%'
    FORMAT TSV`);
  const [queries = 0, rows = 0, bytes = 0, memory = 0] = row
    .trim()
    .split("\t")
    .map(Number);
  return { queries, rows, bytes, memory };
}

async function now(): Promise<string> {
  return (await clickhouse("SELECT toString(now64(6)) FORMAT TSV")).trim();
}

type Result = {
  name: string;
  medianMs: number;
  minMs: number;
  maxMs: number;
  queries: number;
  chRowsRead: number;
  chBytesRead: number;
  chPeakMemory: number;
  entries: number;
  complete: boolean;
  error?: string;
};

const results: Result[] = [];

async function measure(
  name: string,
  op: (counted: Counted) => Promise<{ entries: number; complete: boolean }>,
): Promise<void> {
  const times: number[] = [];
  let last: { entries: number; complete: boolean } = {
    entries: 0,
    complete: false,
  };
  let counted: Counted = { queries: 0 };
  let read = { queries: 0, rows: 0, bytes: 0, memory: 0 };
  let error: string | undefined;
  try {
    // One warm-up read, so every version is timed against warm caches.
    await runInTenantScope(SCOPE, () => op({ queries: 0 }));
    for (let i = 0; i < RUNS; i += 1) {
      counted = { queries: 0 };
      const since = await now();
      const start = performance.now();
      last = await runInTenantScope(SCOPE, () => op(counted));
      times.push(performance.now() - start);
      read = await readSince(since);
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  times.sort((a, b) => a - b);
  results.push({
    name,
    medianMs: Math.round(times[Math.floor(times.length / 2)] ?? 0),
    minMs: Math.round(times[0] ?? 0),
    maxMs: Math.round(times.at(-1) ?? 0),
    queries: counted.queries,
    chRowsRead: read.rows ?? 0,
    chBytesRead: read.bytes ?? 0,
    chPeakMemory: read.memory ?? 0,
    entries: last.entries,
    complete: last.complete,
    ...(error === undefined ? {} : { error }),
  });
}

const input = (over: Record<string, unknown>) =>
  runTranscriptGet.input.parse(over);

/** The whole-run read the Cost, Policy and Context tabs make (whole-transcript.ts). */
async function whole(
  transcript: ReturnType<typeof handler>,
  runId: string,
  zoom: string,
): Promise<{ entries: number; complete: boolean }> {
  let page = await transcript(input({ runId, zoom }), ctx(SCOPE));
  let entries = page.entries.length;
  for (
    let pages = 1;
    pages < 50 && page.cursor !== null && page.entries.length >= 200;
    pages += 1
  ) {
    page = await transcript(
      input({ runId, zoom, after: page.cursor }),
      ctx(SCOPE),
    );
    entries += page.entries.length;
  }
  return { entries, complete: page.complete && page.cursor === null };
}

describe.skipIf(!url)("get_run_transcript benchmark", () => {
  beforeAll(() => {
    process.env["CLICKHOUSE_URL"] = url;
    process.env["CLICKHOUSE_USERNAME"] = "bench";
    process.env["CLICKHOUSE_PASSWORD"] = "bench";
    process.env["CLICKHOUSE_DATABASE"] = "bench";
    setDataPlaneResolver((orgId, kind) =>
      Promise.resolve({ orgId, kind, mode: "shared", status: "active" }),
    );
  });

  afterAll(async () => {
    clearDataPlaneResolver();
    await closeClickhouse();
    console.table(results);
    const out = process.env["BENCH_OUT"];
    if (out) writeFileSync(out, JSON.stringify(results, null, 2));
  });

  it("times the Run page's transcript reads", {
    timeout: 1_800_000,
  }, async () => {
    for (const run of [MID, BIG]) {
      const size = run === BIG ? "250k" : "25k";
      await measure(`${size} first page`, async (counted) => {
        const page = await handler("completed", counted)(
          input({ runId: run.publicId, zoom: "everything" }),
          ctx(SCOPE),
        );
        return { entries: page.entries.length, complete: page.complete };
      });
      const first = await runInTenantScope(SCOPE, () =>
        handler("completed", { queries: 0 })(
          input({ runId: run.publicId, zoom: "everything" }),
          ctx(SCOPE),
        ),
      );
      expect(first.cursor).not.toBeNull();
      await measure(`${size} second page`, async (counted) => {
        const page = await handler("completed", counted)(
          input({
            runId: run.publicId,
            zoom: "everything",
            after: first.cursor,
          }),
          ctx(SCOPE),
        );
        return { entries: page.entries.length, complete: page.complete };
      });
      // A live run at its tail: the read each stream signal triggers.
      const tail = await runInTenantScope(SCOPE, async () => {
        const transcript = handler("running", { queries: 0 });
        let page = await transcript(
          input({ runId: run.publicId, zoom: "everything" }),
          ctx(SCOPE),
        );
        let cursor = page.cursor;
        for (let i = 0; i < 2_000 && page.entries.length > 0; i += 1) {
          cursor = page.cursor;
          page = await transcript(
            input({ runId: run.publicId, zoom: "everything", after: cursor }),
            ctx(SCOPE),
          );
        }
        return page.cursor ?? cursor;
      });
      await measure(`${size} live poll at tail`, async (counted) => {
        const page = await handler("running", counted)(
          input({ runId: run.publicId, zoom: "everything", after: tail }),
          ctx(SCOPE),
        );
        return { entries: page.entries.length, complete: page.complete };
      });
      await measure(
        `${size} cost tab (turns + steps, whole run)`,
        async (counted) => {
          const transcript = handler("completed", counted);
          const [turns, steps] = await Promise.all([
            whole(transcript, run.publicId, "turns"),
            whole(transcript, run.publicId, "steps"),
          ]);
          return {
            entries: turns.entries + steps.entries,
            complete: turns.complete && steps.complete,
          };
        },
      );
    }
  });
});
