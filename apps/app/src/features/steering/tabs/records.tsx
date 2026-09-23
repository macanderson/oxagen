// The Library's Records shelf (roadmap pages/steering-records.md): the
// Published records panel over every record in force, then On disk and
// Injection points side by side.
//
// Three reads, each its own: the records in force (read whole, so the kind
// counts, the sort and the pages cover every record and not one page of
// them), the steering freshness for the bundle the last merge published, and
// the main repository's `.oxagen/` tree. The hub has already read the
// registry, so a refused or failed registry read never reaches this shelf;
// the freshness and the tree fail inside their own panels.
import type { RecordKind } from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { readLibrary } from "../library-read";
import {
  InjectionPoints,
  OnDisk,
  RecordsReadFailure,
} from "../records-panels";
import { RecordsList } from "../records-shelf";
import type { SteeringAt } from "../view";

export async function RecordsShelf({
  ctx,
  source,
  at,
  kind,
}: {
  ctx: WsCtx;
  source: DataSource;
  at: SteeringAt;
  kind: RecordKind | null;
}) {
  const [library, freshness, tree] = await Promise.all([
    readLibrary(ctx, source),
    source.steering.freshness(ctx),
    source.steering.tree(ctx),
  ]);
  return (
    <div className="flex flex-col gap-3.5" data-testid="shelf-records">
      {library.ok ? (
        <RecordsList
          at={at}
          kind={kind}
          records={library.value.records}
          total={library.value.total}
          bundle={
            freshness.ok
              ? {
                  version: freshness.value.version,
                  headCommit: freshness.value.headCommit,
                }
              : null
          }
        />
      ) : (
        <RecordsReadFailure read={library} />
      )}
      <div className="grid gap-3.5 lg:grid-cols-2">
        <OnDisk tree={tree} />
        <InjectionPoints />
      </div>
    </div>
  );
}
