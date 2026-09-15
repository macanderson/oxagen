// `get_run`: the Run page's header and one page of frames.
//
// The header is the same row `list_runs` builds, read for one run. Frames
// come from the store that recorded the run (lib/run-read.ts): the ledger
// run's V2 events cursored on the run's decimal `run_seq`, or the wrapped
// session's hash-chained events cursored on its dense `seq`, both behind an
// opaque cursor this handler owns. Each frame carries its body reference and
// never its bytes (ADR-058; `get_run_frame_body` reads those on demand) and
// its own cost record when it carried one.
//
// `waitMs` is the handler-side long poll (ARCHITECTURE.md §3.5): with no event
// past the cursor, the handler sleeps POLL_INTERVAL_MS at a time inside the
// tenant scope until one lands or the budget runs out. The gates and the audit
// emissions already happened, once, before this handler started.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  type RunFrame as RunFrameOut,
  runGet,
  type RunGetOutput,
} from "@oxagen/oxagen/contracts/run.get";
import type { RunFrame } from "@oxagen/run-ledger";
import { invalidCursor, microsString, runScope } from "./run.list";
import {
  defaultRunReadDeps,
  readFrames,
  resolveRun,
  type ResolvedRun,
  type RunReadDeps,
  startCursorSeq,
} from "./lib/run-read";

/** How often the long poll re-reads the store. */
export const POLL_INTERVAL_MS = 500;

const DECIMAL = /^\d+$/;

/** The largest `run_seq` the ledger can hold: `run_seq` is a Postgres bigint. */
const RUN_SEQ_MAX = 9223372036854775807n;

// ---- Frame cursor ---------------------------------------------------------------------

/** The cursor for a frame: its sequence, wrapped so the shape stays ours. */
export function encodeFrameCursor(seq: string): string {
  return Buffer.from(`f:${seq}`, "utf8").toString("base64url");
}

/**
 * The sequence a cursor names, or null for a cursor this handler did not
 * write. The handler only mints cursors for values the bigint column holds,
 * so a decimal past int8 max is refused here; passed through, the store's
 * `::bigint` cast would raise and surface as a 500.
 */
export function decodeFrameCursor(raw: string): string | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  if (!text.startsWith("f:")) return null;
  const seq = text.slice(2);
  if (!DECIMAL.test(seq)) return null;
  if (seq.length > 19 || BigInt(seq) > RUN_SEQ_MAX) return null;
  return seq;
}

// ---- Frames ---------------------------------------------------------------------------

/** The wire frame: the projection plus its cursor, the body as a reference. */
export function toFrame(frame: RunFrame): RunFrameOut {
  return {
    cursor: encodeFrameCursor(frame.seq),
    seq: frame.seq,
    type: frame.type,
    stage: frame.stage,
    observedAt: frame.observedAt.toISOString(),
    digest: frame.digest,
    summary: frame.summary,
    body: {
      digest: frame.body.bodyDigest,
      bytesRef: frame.body.bodyRef,
      redactions: (frame.body.redactions ?? []).map((r) => ({
        path: r.path,
        reason: r.reason,
        originalDigest: r.original_digest,
      })),
      fidelity: frame.body.fidelity,
    },
    cost:
      frame.costMicros === null
        ? null
        : {
            micros: microsString(frame.costMicros),
            currency: "USD",
            basis: "client_attested",
          },
  };
}

// ---- Dependencies ---------------------------------------------------------------------

export type RunGetDeps = RunReadDeps & {
  /** The long poll's clock, injectable so a test does not wait. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export function createRunGetHandler(
  deps: RunGetDeps,
): CapabilityHandler<typeof runGet> {
  async function poll(
    run: ResolvedRun,
    after: string,
    limit: number,
    waitMs: number,
  ): Promise<RunFrame[]> {
    const deadline = deps.now() + waitMs;
    for (;;) {
      const batch = await readFrames(deps, run, after, limit);
      if (batch.length > 0) return batch;
      const remaining = deadline - deps.now();
      if (remaining <= 0) return batch;
      await deps.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  return async (input, ctx): Promise<RunGetOutput> => {
    const scope = runScope(ctx);
    const cursor =
      input.framesAfter === undefined
        ? undefined
        : decodeFrameCursor(input.framesAfter);
    if (cursor === null) throw invalidCursor(runGet.name);

    const run = await resolveRun(deps, scope, input.runId);
    const frames = await poll(
      run,
      cursor ?? startCursorSeq(run),
      input.frameLimit,
      input.waitMs,
    );
    const last = frames.at(-1);
    return {
      run: run.item,
      frames: {
        frames: frames.map(toFrame),
        cursor: last ? encodeFrameCursor(last.seq) : null,
      },
    };
  };
}

export function defaultRunGetDeps(): RunGetDeps {
  return {
    ...defaultRunReadDeps(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export const runGetHandler = createRunGetHandler(defaultRunGetDeps());
