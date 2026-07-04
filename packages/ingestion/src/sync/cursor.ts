/**
 * Durable cursor advancement for the generic poll/sync loop.
 *
 * A connection's `cursor` is a JSONB map of `{ [sourceRecordType]: cursorValue }`
 * persisted in ingestion.source_connections. Each poll passes the prior cursor
 * for a record type into `connector.poll()` (which uses it to fetch only changed
 * records), then advances it from the batch just fetched.
 *
 * The cursor value is whatever the connector reports via `cursorOf()` — by
 * convention the source's last-modified ISO-8601 timestamp, which sorts
 * correctly as a plain string, so "advance" is just the lexicographic max.
 * Connectors that don't expose `cursorOf` leave the cursor untouched and simply
 * re-poll their window each cycle (the ingestion dedup stage makes that safe,
 * just less efficient).
 */

import type { ConnectorDefinition, RawRecord } from "../connectors/types";

/** Read the per-record-type cursor out of a connection's JSONB cursor map. */
export function readCursor(
  cursorMap: Record<string, unknown> | null | undefined,
  recordType: string,
): string | null {
  const v = cursorMap?.[recordType];
  return typeof v === "string" ? v : null;
}

/**
 * Given a batch of raw records just polled for one record type and the prior
 * cursor, return the new cursor: the max `cursorOf()` across the batch, or the
 * prior cursor when the connector has no `cursorOf` or the batch produced no
 * larger value. ISO-8601 timestamps compare correctly with `>`.
 */
export function advanceCursor(
  connector: Pick<ConnectorDefinition, "cursorOf">,
  recordType: string,
  records: readonly RawRecord[],
  priorCursor: string | null,
): string | null {
  if (!connector.cursorOf) return priorCursor;
  let max = priorCursor;
  for (const rec of records) {
    const candidate = connector.cursorOf(recordType, rec.raw);
    if (candidate !== null && (max === null || candidate > max)) {
      max = candidate;
    }
  }
  return max;
}

/**
 * Merge an advanced per-record-type cursor back into the connection's cursor
 * map without mutating the input. Returns a fresh object safe to persist as
 * JSONB. A null `next` clears that record type's cursor.
 */
export function mergeCursor(
  cursorMap: Record<string, unknown> | null | undefined,
  recordType: string,
  next: string | null,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(cursorMap ?? {}) };
  if (next === null) {
    delete merged[recordType];
  } else {
    merged[recordType] = next;
  }
  return merged;
}
