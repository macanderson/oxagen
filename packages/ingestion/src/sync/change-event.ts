/**
 * Which change event, if any, the ingestion pipeline sends after it writes a
 * node. The change events (`ingestion/entity.created` and
 * `ingestion/entity.updated`) are the feed that trigger conditions read, so
 * this is the one place that decides whether a write can fire a trigger.
 *
 * Two kinds of write send nothing (#5263):
 *
 * 1. A backfill write. The initial sync and the first poll after a connection
 *    read records that mostly predate the connection. A trigger such as
 *    `git_branch = 'main'` must not fire for every old commit they read.
 * 2. An update that changes no property. The webhook and the poll can both
 *    read one commit. The webhook's write creates the node and fires its
 *    trigger. The poll's later write of the same values is not a change, so
 *    it fires nothing.
 */

export type ChangeEventKind = "created" | "updated";

export interface ChangeEventInput {
  /** The write created a new principal node. */
  created: boolean;
  /** The record was read at connect time, not delivered as a change. */
  backfill: boolean;
  /** The properties the write stored. */
  properties: Readonly<Record<string, unknown>>;
  /** The properties the node held before the write, or null when unknown. */
  previousProperties: Readonly<Record<string, unknown>> | null;
}

/**
 * The change event to send for one node write, or null for none. An update
 * whose earlier properties are unknown counts as a change.
 */
export function changeEventKind(input: ChangeEventInput): ChangeEventKind | null {
  if (input.backfill) return null;
  if (input.created) return "created";
  if (
    input.previousProperties !== null &&
    samePropertySnapshot(input.previousProperties, input.properties)
  )
    return null;
  return "updated";
}

/**
 * Whether two property snapshots hold the same values. The node stores its
 * properties as JSON, which drops `undefined` values and keeps key order, so
 * both sides go through the same JSON form and compare with sorted keys.
 */
function samePropertySnapshot(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value))));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  );
}
