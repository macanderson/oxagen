import { PageHeaderSkeleton, TableSkeleton } from "@/components/loading";

/**
 * Mirrors the workflows/automations loading skeletons: header over a
 * placeholder table while the dispatch tree (or the recent-dispatch picker)
 * streams in.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeaderSkeleton />
      <TableSkeleton rows={6} cols={6} />
    </div>
  );
}
