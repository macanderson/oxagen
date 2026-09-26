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
// the next page, the poll a live run's stream triggers, the whole-run read
// the page's figures come from (at 200 entries a page, as it read before
// #4067, and at 500, as it reads now), the whole run and a live poll at
// `steps`, the zoom the page draws, the two whole-run reads the Cost tab made
// before #4067, and the one `get_run_turns` read it makes now. Every case
// reports the median wall time over several runs, the ClickHouse queries it
// issued, and the rows and bytes ClickHouse read for it (from
// `system.query_log`).
//
// The seeded frames keep no bodies, so this file gives each prompt, reply,
// model call and tool result one as it reads the frame: a short text body in
// memory, named and digested the way the evidence store names one. Each read
// of a body waits BENCH_BODY_MS (default 2), standing in for the blob GET and
// KMS decrypt a production read pays, and each case reports the bodies it
// read (`bodyReads`). The handlers share one words cache, as the one handler a
// process serves from does, so a case timed after its warm-up read measures a
// warm process; a case named `cold` gives every read a fresh cache, which is
// what the first read of a run in a process pays.
//
// The subagent chains come from a fixed list here, so the Postgres query that
// lists them in production is not timed. A case that times out is recorded
// with its error, and the rest still run.
import { writeFileSync } from "node:fs";
import {
  runTranscriptGet,
  TRANSCRIPT_ENTRY_MAX,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import { runTurnsGet } from "@oxagen/oxagen/contracts/run.turns.get";
import {
  runInTenantScope,
  setDataPlaneResolver,
  clearDataPlaneResolver,
} from "@oxagen/tenancy";
import { digestBytes } from "@oxagen/tacho";
import {
  closeClickhouse,
  type TachoFrameRow,
  selectTachoEvents,
  selectTachoSubagentEvents,
  selectTachoTurnFacts,
  selectTachoTurnGroups,
} from "@oxagen/telemetry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRunTranscriptGetHandler,
  type RunTranscriptGetDeps,
} from "./run.transcript.get";
import { createRunTurnsGetHandler } from "./run.turns.get";
import {
  createWordsCache,
  type WordsCache,
} from "./lib/transcript-words-cache";
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

type Counted = { queries: number; bodies: number };

const counter = (): Counted => ({ queries: 0, bodies: 0 });

/** The wait standing in for one body's blob GET and KMS decrypt. */
const BODY_MS = Number(process.env["BENCH_BODY_MS"] ?? 2);
/** The frames that keep a body: prompts, replies, model calls, tool results. */
const RETAINED = new Set(["turn_start", "turn_end", "llm_call", "tool_call"]);
const enc = new TextEncoder();
const kept = new Map<string, Uint8Array>();

/** `row` with a body kept for it, when its kind keeps one. */
function withBody(row: TachoFrameRow): TachoFrameRow {
  if (!RETAINED.has(row.kind)) return row;
  const bytes = enc.encode(
    `${row.kind} ${row.sessionUuid ?? "root"}:${row.seq}: ${"words ".repeat(40)}`,
  );
  const contentDigest = digestBytes(bytes);
  const bytesRef = `evb:v1:bench:${contentDigest.slice("sha256:".length)}`;
  kept.set(bytesRef, bytes);
  return { ...row, contentDigest, bytesRef };
}

/** The words cache the benchmark's handlers share, as one process's do. */
let shared = createWordsCache();

function deps(
  outcome: string,
  counted: Counted,
  words: WordsCache = shared,
): RunTranscriptGetDeps {
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
  const built: RunTranscriptGetDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: () => Promise.resolve(null),
      readAttemptEventsSince: memoryEvents([]),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: async (args) => {
      counted.queries += 1;
      return (await selectTachoEvents(args)).map(withBody);
    },
    tachoSubagentFrames: async (args) => {
      counted.queries += 1;
      return (await selectTachoSubagentEvents(args)).map(withBody);
    },
    tachoChildSessions: (root) =>
      Promise.resolve(root === BIG.sessionUuid ? BIG_CHILDREN : []),
    bodies: {
      getBody: async (_scope, ref) => {
        counted.bodies += 1;
        const bytes = kept.get(ref);
        if (bytes === undefined) throw new Error(`no body for ${ref}`);
        if (BODY_MS > 0)
          await new Promise((resolve) => setTimeout(resolve, BODY_MS));
        return {
          bytes,
          contentType: "text/plain",
          digestHex: ref.slice(-64),
        };
      },
      getAssembly: () => Promise.resolve(null),
    },
    priceBook: () => Promise.resolve([]),
    words,
  };
  return built;
}

function handler(outcome: string, counted: Counted) {
  return createRunTranscriptGetHandler(deps(outcome, counted));
}

/** A handler with a words cache of its own: a process's first read of a run. */
function coldHandler(outcome: string, counted: Counted) {
  return createRunTranscriptGetHandler(
    deps(outcome, counted, createWordsCache()),
  );
}

/** `get_run_turns` over the same store, counting its ClickHouse reads. */
function turnsHandler(counted: Counted) {
  return createRunTurnsGetHandler({
    ...deps("completed", counted),
    tachoTurnFacts: (args) => {
      counted.queries += 1;
      return selectTachoTurnFacts(args);
    },
    tachoTurnGroups: (args) => {
      counted.queries += 1;
      return selectTachoTurnGroups(args);
    },
  });
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
  bodyReads: number;
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
  let counted: Counted = counter();
  let read = { queries: 0, rows: 0, bytes: 0, memory: 0 };
  let error: string | undefined;
  try {
    // One warm-up read, so every version is timed against warm caches.
    await runInTenantScope(SCOPE, () => op(counter()));
    for (let i = 0; i < RUNS; i += 1) {
      counted = counter();
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
    bodyReads: counted.bodies,
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

/**
 * A whole-run read the way whole-transcript.ts pages it: `limit` entries a
 * page, up to 10,000 entries in all.
 */
async function whole(
  transcript: ReturnType<typeof handler>,
  runId: string,
  zoom: string,
  limit = 200,
  text?: "full",
): Promise<{ entries: number; complete: boolean }> {
  const shape = text === undefined ? {} : { text };
  let page = await transcript(
    input({ runId, zoom, limit, ...shape }),
    ctx(SCOPE),
  );
  let entries = page.entries.length;
  for (
    let pages = 1;
    pages < 10_000 / limit &&
    page.cursor !== null &&
    page.entries.length >= limit;
    pages += 1
  ) {
    page = await transcript(
      input({ runId, zoom, limit, after: page.cursor, ...shape }),
      ctx(SCOPE),
    );
    entries += page.entries.length;
  }
  return { entries, complete: page.complete && page.cursor === null };
}

describe.skipIf(!url)("get_run_transcript benchmark", () => {
  beforeAll(() => {
    shared = createWordsCache();
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
        handler("completed", counter())(
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
        const transcript = handler("running", counter());
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
      await measure(`${size} whole run, 200 a page`, (counted) =>
        whole(handler("completed", counted), run.publicId, "everything"),
      );
      await measure(`${size} whole run, 500 a page`, (counted) =>
        whole(
          handler("completed", counted),
          run.publicId,
          "everything",
          TRANSCRIPT_ENTRY_MAX,
        ),
      );
      // The Run page's own read: the whole run at `steps`, each body whole,
      // which reads the run's prompts and replies for their words. Cold is a
      // process's first read of the run; warm is every read after it.
      await measure(`${size} steps whole run, 500 a page, cold`, (counted) =>
        whole(
          coldHandler("completed", counted),
          run.publicId,
          "steps",
          TRANSCRIPT_ENTRY_MAX,
          "full",
        ),
      );
      await measure(`${size} steps whole run, 500 a page`, (counted) =>
        whole(
          handler("completed", counted),
          run.publicId,
          "steps",
          TRANSCRIPT_ENTRY_MAX,
          "full",
        ),
      );
      const stepsTail = await runInTenantScope(SCOPE, async () => {
        const transcript = handler("running", counter());
        const read = (after?: string) =>
          transcript(
            input({
              runId: run.publicId,
              zoom: "steps",
              limit: TRANSCRIPT_ENTRY_MAX,
              text: "full",
              ...(after === undefined ? {} : { after }),
            }),
            ctx(SCOPE),
          );
        let page = await read();
        let cursor = page.cursor;
        for (let i = 0; i < 2_000 && page.entries.length > 0; i += 1) {
          cursor = page.cursor;
          page = await read(cursor ?? undefined);
        }
        return page.cursor ?? cursor;
      });
      await measure(`${size} steps live poll at tail`, async (counted) => {
        const page = await handler("running", counted)(
          input({
            runId: run.publicId,
            zoom: "steps",
            text: "full",
            after: stepsTail,
          }),
          ctx(SCOPE),
        );
        return { entries: page.entries.length, complete: page.complete };
      });
      await measure(`${size} cost tab (get_run_turns)`, async (counted) => {
        const out = await turnsHandler(counted)(
          runTurnsGet.input.parse({ runId: run.publicId }),
          ctx(SCOPE),
        );
        return { entries: out.turns.length, complete: out.complete };
      });
      await measure(
        `${size} cost tab before #4067 (turns + steps, whole run)`,
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
