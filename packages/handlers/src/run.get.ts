// `get_run`: the Run page's header and one page of frames.
//
// The header is the same row `list_runs` builds, read for one run. Frames are
// the ledger run's V2 events (`@oxagen/run-ledger` readAttemptEventsSince),
// cursored on the run's own decimal `run_seq` behind an opaque cursor. A
// wrapped (tacho) session answers `frames: null`: its events live in
// ClickHouse `tacho_events`, which has no read seam yet.
//
// A run the caller's workspace does not hold is `not_found`, whichever store
// minted its id: RunStore fences the org through RLS, and the identity query
// fences the workspace as well, which also holds on a stack that runs with
// the RLS bypass on.
//
// `waitMs` is the handler-side long poll (ARCHITECTURE.md §3.5): with no event
// past the cursor, the handler sleeps POLL_INTERVAL_MS at a time inside the
// tenant scope until one lands or the budget runs out. The gates and the audit
// emissions already happened, once, before this handler started.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  type RunFrame,
  runGet,
  type RunGetOutput,
} from "@oxagen/oxagen/contracts/run.get";
import {
  type AttemptEventReadRecord,
  createPostgresRunStore,
  type RunStore,
} from "@oxagen/run-ledger";
import { sumTokenUsageByExecutionStep } from "@oxagen/telemetry";
import {
  invalidCursor,
  ledgerEnrichment,
  postgresRunQueries,
  type RunQueries,
  runScope,
  type SumTokenUsage,
  toLedgerRunItem,
  toTachoRunItem,
} from "./run.list";

/** How often the long poll re-reads the ledger. */
export const POLL_INTERVAL_MS = 500;

const DECIMAL = /^\d+$/;

// ---- Frame cursor ---------------------------------------------------------------------

/** The cursor for an event: its `run_seq`, wrapped so the shape stays ours. */
export function encodeFrameCursor(runSeq: string): string {
  return Buffer.from(`f:${runSeq}`, "utf8").toString("base64url");
}

/** The `run_seq` a cursor names, or null for a cursor this handler did not write. */
export function decodeFrameCursor(raw: string): string | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  if (!text.startsWith("f:")) return null;
  const seq = text.slice(2);
  return DECIMAL.test(seq) ? seq : null;
}

// ---- Frames ---------------------------------------------------------------------------

function field(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * A short, machine-derived label: identifiers from the inline receipt
 * metadata, never prose. An encrypted payload shows its event type and nothing
 * it cannot read.
 */
export function frameSummary(event: AttemptEventReadRecord): string {
  const p = event.payload;
  switch (event.eventType) {
    case "admission.run_admitted": {
      const name = field(p, "engine_name");
      const version = field(p, "engine_version");
      return name && version ? `${name}@${version}` : event.eventType;
    }
    case "context.frames_selected": {
      const frames = field(p, "frame_count");
      return frames ? `frames=${frames}` : event.eventType;
    }
    case "model.call_completed": {
      const provider = field(p, "provider");
      const model = field(p, "model");
      return provider && model ? `${provider}/${model}` : event.eventType;
    }
    case "tool.call_completed": {
      const capability = field(p, "capability_name");
      const outcome = field(p, "outcome");
      return capability && outcome
        ? `${capability} ${outcome}`
        : event.eventType;
    }
    default:
      return event.eventType;
  }
}

export function toFrame(event: AttemptEventReadRecord): RunFrame {
  return {
    cursor: encodeFrameCursor(event.runSeq),
    seq: event.runSeq,
    type: event.eventType,
    stage: event.stage,
    observedAt: event.observedAt.toISOString(),
    digest: event.eventDigest,
    summary: frameSummary(event),
  };
}

// ---- Dependencies ---------------------------------------------------------------------

export type RunGetDeps = {
  queries: Pick<
    RunQueries,
    "ledgerIdentity" | "ledgerRollups" | "ledgerSeals" | "tachoSession"
  >;
  store: Pick<RunStore, "getRunByPublicId" | "readAttemptEventsSince">;
  sumTokenUsage: SumTokenUsage;
  /** The long poll's clock, injectable so a test does not wait. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const runNotFound = () => new HandlerError("not_found", "run_not_found");

export function createRunGetHandler(
  deps: RunGetDeps,
): CapabilityHandler<typeof runGet> {
  async function readFrames(
    runId: string,
    after: string,
    limit: number,
    waitMs: number,
  ): Promise<AttemptEventReadRecord[]> {
    const deadline = deps.now() + waitMs;
    for (;;) {
      const batch = await deps.store.readAttemptEventsSince(
        runId,
        after,
        limit,
      );
      if (batch.length > 0) return batch;
      const remaining = deadline - deps.now();
      if (remaining <= 0) return batch;
      await deps.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  return async (input, ctx): Promise<RunGetOutput> => {
    const scope = runScope(ctx);
    const after =
      input.framesAfter === undefined
        ? "0"
        : decodeFrameCursor(input.framesAfter);
    if (after === null) throw invalidCursor(runGet.name);

    if (input.runId.startsWith("tse_")) {
      const row = await deps.queries.tachoSession(scope, input.runId);
      if (!row) throw runNotFound();
      return { run: toTachoRunItem(row), frames: null };
    }

    const summary = await deps.store.getRunByPublicId(input.runId);
    if (!summary) throw runNotFound();
    const row = await deps.queries.ledgerIdentity(scope, summary.runId);
    if (!row) throw runNotFound();
    const id = summary.runId;

    const [enrich, events] = await Promise.all([
      ledgerEnrichment(deps, scope, [id]),
      readFrames(id, after, input.frameLimit, input.waitMs),
    ]);
    const last = events.at(-1);
    return {
      run: toLedgerRunItem(enrich(row)),
      frames: {
        frames: events.map(toFrame),
        cursor: last ? encodeFrameCursor(last.runSeq) : null,
      },
    };
  };
}

export function defaultRunGetDeps(): RunGetDeps {
  // Construction is pure: nothing connects until a read runs inside the scope.
  const ledger = createPostgresRunStore();
  return {
    queries: postgresRunQueries,
    store: {
      getRunByPublicId: (id) => ledger.getRunByPublicId(id),
      readAttemptEventsSince: (id, after, limit) =>
        ledger.readAttemptEventsSince(id, after, limit),
    },
    sumTokenUsage: sumTokenUsageByExecutionStep,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export const runGetHandler = createRunGetHandler(defaultRunGetDeps());
