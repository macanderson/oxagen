// `get_run`: the Run page's header and one page of frames.
//
// The header is the same row `list_runs` builds, read for one run. Frames
// come from the store that recorded the run (lib/run-read.ts): the ledger
// run's V2 events cursored on the run's decimal `run_seq`, or the wrapped
// session's hash-chained events cursored on its dense `seq`, both behind an
// opaque cursor this handler owns. Each frame carries its body reference and
// never its bytes (ADR-058; `get_run_frame_body` reads those on demand) and
// its own cost record when it carried one. A witness run answers the worker
// run it reported on as `witnessFor` (ADR-064); to an API-key caller a
// witness run is `not_found` (lib/run-read.ts).
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
  RUN_DIFF_TEXT_MAX,
} from "@oxagen/oxagen/contracts/run.get";
import type { RunFrame } from "@oxagen/run-ledger";
import type { EvidenceStore } from "@oxagen/run-ledger/evidence-store";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import { digestBytes } from "@oxagen/tacho";
import {
  invalidCursor,
  microsString,
  runScope,
  type RunScope,
} from "./run.list";
import {
  defaultRunReadDeps,
  readFrames,
  readAllFrames,
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
  bodies?: Pick<EvidenceStore, "getBody">;
  /** The long poll's clock, injectable so a test does not wait. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/** A capped scan must never present an older reconciliation as the latest. */
export const RUN_DIFF_FRAME_CAP = 10_000;
const DIFF_BODY_BYTES_MAX = 1_048_576;
const diffDecoder = new TextDecoder("utf-8", { fatal: true });

async function readDiff(
  deps: RunGetDeps,
  run: ResolvedRun,
  scope: RunScope,
): Promise<NonNullable<RunGetOutput["diff"]>> {
  const read = await readAllFrames(deps, run, RUN_DIFF_FRAME_CAP);
  const unavailable = {
    patch: null,
    truncated: false,
    complete: read.complete,
    seq: null,
  };
  if (!read.complete) return unavailable;
  const frame = [...read.frames]
    .reverse()
    .find((f) => f.type === "oxagen:worktree_reconciled");
  if (!frame) return unavailable;
  const base = { ...unavailable, seq: frame.seq };
  const { bodyRef, bodyDigest, fidelity } = frame.body;
  if (
    !deps.bodies ||
    fidelity !== "full" ||
    bodyRef === null ||
    bodyDigest === null
  )
    return base;
  // The reference comes from the tenant-scoped frame, never from input or host paths.
  try {
    const stored = await deps.bodies.getBody(scope, bodyRef);
    if (
      stored.bytes.length > DIFF_BODY_BYTES_MAX ||
      digestBytes(stored.bytes) !== bodyDigest
    )
      return base;
    const captured: unknown = JSON.parse(diffDecoder.decode(stored.bytes));
    if (captured === null || typeof captured !== "object") return base;
    const value = captured as Record<string, unknown>;
    if (
      typeof value.patch !== "string" ||
      typeof value.truncated !== "boolean" ||
      value.scope !== "tracked_worktree"
    )
      return base;
    return {
      ...base,
      patch: value.patch.slice(0, RUN_DIFF_TEXT_MAX),
      ...(typeof value.baseSha === "string" && value.baseSha.length <= 128
        ? { baseSha: value.baseSha }
        : {}),
      truncated: value.truncated || value.patch.length > RUN_DIFF_TEXT_MAX,
    };
  } catch {
    // Expired bodies and redaction can make content unavailable. Never infer an empty diff.
    return base;
  }
}

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
    const cursor =
      input.framesAfter === undefined
        ? undefined
        : decodeFrameCursor(input.framesAfter);
    if (cursor === null) throw invalidCursor(runGet.name);

    const run = await resolveRun(deps, ctx, input.runId);
    // One frame past the page tells a full page from the end of the recording.
    // A sealed run whose page had nothing behind it answers no cursor, because
    // nothing will ever lie past it; a live run keeps its resume point, since
    // the next frame may still arrive.
    const batch = await poll(
      run,
      cursor ?? startCursorSeq(run),
      input.frameLimit + 1,
      input.waitMs,
    );
    const frames = batch.slice(0, input.frameLimit);
    const last = frames.at(-1);
    const ended =
      batch.length <= input.frameLimit && run.item.status !== "live";
    return {
      run: run.item,
      frames: {
        frames: frames.map(toFrame),
        cursor: last && !ended ? encodeFrameCursor(last.seq) : null,
      },
      witnessFor: run.witnessFor,
      ...(input.includeDiff
        ? { diff: await readDiff(deps, run, runScope(ctx)) }
        : {}),
    };
  };
}

export function defaultRunGetDeps(): RunGetDeps {
  return {
    ...defaultRunReadDeps(),
    get bodies() {
      return evidenceStore();
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export const runGetHandler = createRunGetHandler(defaultRunGetDeps());
