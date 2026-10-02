/**
 * How a frame reached the record (ADR-161). A chain `oxagen agent backfill`
 * rebuilt from a finished transcript marks every frame it seals, inside the
 * hash, so the host, ingest, the rollup and the Run page read the same mark.
 */

/** The attr every backfilled frame carries, with the value `backfill`. */
export const RECORD_BASIS_ATTR = "oxagen.record_basis";

/**
 * The attr a backfilled session's `agent_start` carries: the normalizer
 * version the pass sealed it under. Ingest keeps it on the session row, and a
 * later pass reads it back through `list_tacho_session_heads`.
 */
export const BACKFILL_NORMALIZER_ATTR = "oxagen.backfill_normalizer";

/** The `completeness_gaps` entry a backfilled session's seal carries. */
export const BACKFILL_COMPLETENESS_GAP = "backfill";

/** The values `tacho.sessions.record_basis` takes. */
export type RecordBasis = "live" | "backfill" | "mixed";

/** Whether a backfill sealed this frame. */
export function isBackfilledFrame(event: {
  attrs: Record<string, string>;
}): boolean {
  return event.attrs[RECORD_BASIS_ATTR] === "backfill";
}

/**
 * The session's record basis after a batch of new frames. A new session
 * whose first frame is backfilled is `backfill`, and turns `mixed` for good
 * once a frame without the mark lands, which is a live resume continuing
 * the chain. A live session stays `live`: a backfill never writes to a
 * session the control plane holds.
 */
export function nextRecordBasis(
  current: RecordBasis | undefined,
  fresh: readonly { attrs: Record<string, string> }[],
): RecordBasis {
  if (current === "mixed" || current === "live") return current;
  if (current === undefined && !(fresh[0] && isBackfilledFrame(fresh[0])))
    return "live";
  return fresh.every(isBackfilledFrame) ? "backfill" : "mixed";
}
