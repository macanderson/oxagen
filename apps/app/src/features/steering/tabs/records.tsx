// The Library's Records shelf (roadmap pages/steering.md; the shelf body is
// pages/steering-records.md, which the steering-library lane builds): the
// records in force, one page at a time, filtered by kind.
import type { RecordKind } from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { Records } from "../records";
import type { SteeringAt } from "../view";

export async function RecordsShelf({
  ctx,
  source,
  at,
  kind,
  offset,
}: {
  ctx: WsCtx;
  source: DataSource;
  at: SteeringAt;
  kind: RecordKind | null;
  offset: number;
}) {
  const read = await source.steering.records(ctx, { kind, offset });
  return <Records at={at} kind={kind} offset={offset} read={read} />;
}
