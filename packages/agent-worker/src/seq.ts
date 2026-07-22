/**
 * Monotonic event-seq assignment for one claimed run — pure, no I/O
 * (docs/specs/agent-engine-v2 Phase 2c). The worker, never the store, assigns
 * seq numbers, so resuming a crashed/reclaimed run must continue from exactly
 * where the last committed checkpoint left off: a fresh run's checkpointSeq is
 * 0 (so its first event is seq 1); a resumed run's first event is
 * `checkpointSeq + 1`. One formula covers both cases.
 */
import type { ClaimedRun } from "./types";

/** The seq the run's first newly-emitted event must carry. */
export function firstSeqForRun(run: Pick<ClaimedRun, "checkpointSeq">): number {
  return run.checkpointSeq + 1;
}

/**
 * A run's own seq cursor. Deliberately just a counter — no dedup/idempotency
 * logic belongs here; that lives server-side (`appendEvents`'
 * `ON CONFLICT DO NOTHING`). This class only guarantees the client-assigned
 * numbers are monotonic and never restart mid-run.
 */
export class SeqCounter {
  private nextSeq: number;

  constructor(firstSeq: number) {
    this.nextSeq = firstSeq;
  }

  /** Assigns and returns the next seq, advancing the cursor. */
  assign(): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return seq;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// V2 — attempt-local sequences and run-global cursors
// ═══════════════════════════════════════════════════════════════════════════
//
// V2 splits the single V1 `seq` into two numbers with different owners and
// different lifetimes, and conflating them is the bug this section exists to
// make impossible:
//
//   attempt_seq  producer-assigned, dense from 1, RESET for every new attempt.
//                Drives unambiguous replay of one execution.
//   run_seq      PostgreSQL-assigned inside the append transaction, monotonic
//                ACROSS attempts. Drives resumable subscriptions.
//
// The worker owns only `attempt_seq`. It never invents a `run_seq` — that would
// be a client guessing at a server-allocated counter — it only carries the
// value the append returned.

/**
 * The first attempt-local sequence. ALWAYS 1, even for a successor that
 * restored a checkpoint: `attempt_seq` identifies a position within ONE
 * attempt, and a restored successor is a new attempt with its own stream. The
 * restored position travels as `restore.attemptSeq`/`restore.streamDigest` on
 * the claim, not as a sequence offset.
 *
 * This is the exact opposite of V1's `firstSeqForRun`, which continues from
 * `checkpointSeq + 1`. Both are correct for their own record version; using
 * either formula for the other produces a stream nobody can verify.
 */
export const FIRST_ATTEMPT_SEQ = 1;

/**
 * An attempt's sequence cursor. Unlike `SeqCounter` it enforces contiguity
 * itself rather than relying on a server-side conflict drop: the V2 append has
 * NO `ON CONFLICT DO NOTHING`, and a hole in `attempt_seq` is rejected by
 * `appendAttemptBatch` as a sequence gap. Catching a skipped assignment here
 * turns a rejected batch into an assertion at the point the bug happened.
 */
export class AttemptSeqCounter {
  private nextSeq: number;
  private lastAssignedSeq: number | null = null;

  constructor(firstSeq: number = FIRST_ATTEMPT_SEQ) {
    if (!Number.isSafeInteger(firstSeq) || firstSeq < 1) {
      throw new RangeError(
        `attempt_seq must be a positive integer, received ${firstSeq}`,
      );
    }
    this.nextSeq = firstSeq;
  }

  /** Assigns and returns the next attempt-local sequence. */
  assign(): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.lastAssignedSeq = seq;
    return seq;
  }

  /** The most recently assigned sequence, or null before the first assign. */
  get lastAssigned(): number | null {
    return this.lastAssignedSeq;
  }

  /** The sequence the next `assign()` will return. */
  get peek(): number {
    return this.nextSeq;
  }
}

/**
 * Assert that a buffered batch is contiguous and starts where the attempt left
 * off, BEFORE handing it to `appendAttemptBatch`. The store re-checks this — it
 * cannot trust a producer — but failing locally names the offending index
 * instead of surfacing a bare sequence gap from the database.
 *
 * `lastAppendedSeq` is 0 for an attempt that has appended nothing yet.
 */
export function assertContiguousAttemptSeqs(
  lastAppendedSeq: number,
  seqs: readonly number[],
): void {
  for (let i = 0; i < seqs.length; i += 1) {
    const expected = lastAppendedSeq + 1 + i;
    if (seqs[i] !== expected) {
      throw new RangeError(
        `non-contiguous attempt_seq at index ${i}: expected ${expected}, received ${String(seqs[i])}`,
      );
    }
  }
}

/**
 * Format a run-global sequence as the exact decimal string an SSE `id:` field
 * carries.
 *
 * `run_seq` is a PostgreSQL `bigint`. A JS `number` silently loses precision
 * past 2^53, so a cursor round-tripped through one would resume a subscription
 * at the wrong event — with no error anywhere. Accepting `bigint` and
 * `string` (and refusing an unsafe `number`) keeps that impossible.
 */
export function formatRunSeqCursor(value: bigint | number | string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        `run_seq ${value} is not a safe non-negative integer; pass a bigint or decimal string`,
      );
    }
    return value.toString();
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new RangeError(`run_seq "${value}" is not a decimal integer string`);
  }
  return value;
}

/**
 * Parse an SSE `Last-Event-ID` back into a `bigint` cursor. Returns 0n for an
 * absent id (a fresh subscription reads from the beginning) and refuses
 * anything that is not an exact decimal integer — a malformed cursor must not
 * silently become 0 and replay the whole run.
 */
export function parseRunSeqCursor(value: string | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new RangeError(`run_seq cursor "${value}" is not a decimal integer`);
  }
  return BigInt(value);
}
