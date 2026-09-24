// The whole list the Library's All shelf draws (roadmap pages/steering.md,
// "Library, the All shelf"). The assembler's order holds across the list, not
// within a page of it, and `list_records` answers in its own order (the most
// recently updated first), so the shelf reads every record in force and orders
// them itself. The search, the filters, the sort and the pages then work over
// the same rows in the browser, as the design's list tools do.
//
// The read asks for `STEERING_READ_MAX` rows a call, the contract's bound, and
// stops at `LIBRARY_READ_CAP` rows. A workspace past the cap is told how many
// rows the list holds out of how many are in force, rather than shown a list
// that looks whole.
import { type RecordPage, STEERING_READ_MAX } from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";
import type { WsCtx } from "@/server/viewer";

/** The most rows the All shelf reads: five calls at the contract's bound. */
const LIBRARY_READ_CAP = 1000;

export async function readLibrary(
  ctx: WsCtx,
  source: DataSource,
): Promise<Read<RecordPage>> {
  const first = await source.steering.records(ctx, {
    kind: null,
    offset: 0,
    limit: STEERING_READ_MAX,
  });
  if (!first.ok) return first;
  const { total } = first.value;
  // Step by what the first call returned, so a store that answers fewer rows
  // than asked still yields every offset and skips none.
  const step = first.value.records.length;
  const offsets: number[] = [];
  for (
    let offset = step;
    step > 0 && offset < Math.min(total, LIBRARY_READ_CAP);
    offset += step
  ) {
    offsets.push(offset);
  }
  const rest = await Promise.all(
    offsets.map((offset) =>
      source.steering.records(ctx, {
        kind: null,
        offset,
        limit: STEERING_READ_MAX,
      }),
    ),
  );
  const records = [...first.value.records];
  for (const page of rest) {
    // One failed page fails the list: a shelf that silently drops a page
    // would print an order and a count the record does not hold.
    if (!page.ok) return page;
    records.push(...page.value.records);
  }
  // A record published between two calls can shift a row across a page
  // boundary; the id keeps it from printing twice.
  const seen = new Set<string>();
  const unique = records.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  return readOk({ records: unique.slice(0, LIBRARY_READ_CAP), total });
}
