import { PageHeaderSkeleton, TableSkeleton } from "@/components/loading";

/**
 * Mirrors the workflows page: header (with the Launch-workflow action) over the
 * streamed workflow-run table.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeaderSkeleton withAction />
      <TableSkeleton rows={6} cols={6} />
    </div>
  );
}
