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
