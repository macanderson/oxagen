/**
 * Append `tacho/1.0` events to ClickHouse `tacho_events`.
 *
 * The row is the package's own flattening of the event (every body member to
 * its column, the whole body as JSON text, unpromoted attributes in the map),
 * projected through the generated column list so an untyped caller cannot
 * smuggle a column that does not exist. Tenant labels are absent by
 * construction: chInsert stamps the authenticated ambient scope, and
 * `chain_verified` is the control plane's verdict, never the producer's.
 */
import { flattenEvent, type TachoEvent } from "@oxagen/tacho";
import { TACHO_EVENTS_TABLE, tachoEventsColumns } from "./tacho-events-ddl";
import { chInsert } from "./tenant";

export interface TachoEventInsert {
  event: TachoEvent;
  /** The control plane recomputed the hash and the link to the prior row. */
  chainVerified: boolean;
  /**
   * The person behind the session, keyed with a secret only the control plane
   * holds (#3072). Absent when the event named nobody, or when the deployment
   * holds no key — in which case the column stays empty and no address is
   * stored either way. Never taken from the producer: `flattenEvent` does not
   * emit this column and `WRITABLE_COLUMNS` would drop it if it did.
   */
  userEmailDigest?: string;
}

const WRITABLE_COLUMNS: ReadonlySet<string> = new Set(
  tachoEventsColumns()
    .map((column) => column.name)
    .filter(
      (name) =>
        name !== "org_id" &&
        name !== "workspace_id" &&
        name !== "received_at" &&
        name !== "anthropic_user_email_digest",
    ),
);

/** One event as the row ClickHouse receives, minus the stamped tenant columns. */
export function tachoEventRow(
  insert: TachoEventInsert,
  receivedAt: string,
): Record<string, unknown> {
  const flat = flattenEvent(insert.event);
  const row: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(flat)) {
    if (WRITABLE_COLUMNS.has(column)) {
      row[column] = value;
    }
  }
  row["chain_verified"] = insert.chainVerified;
  row["received_at"] = receivedAt;
  row["anthropic_user_email_digest"] = insert.userEmailDigest ?? "";
  return row;
}

/**
 * Append events. No-ops on an empty array, so an empty batch costs neither a
 * tenant-scope assertion nor a round-trip.
 */
export async function insertTachoEvents(
  inserts: readonly TachoEventInsert[],
): Promise<void> {
  if (inserts.length === 0) return;
  const receivedAt = new Date().toISOString();
  await chInsert(
    TACHO_EVENTS_TABLE,
    inserts.map((insert) => tachoEventRow(insert, receivedAt)),
  );
}
