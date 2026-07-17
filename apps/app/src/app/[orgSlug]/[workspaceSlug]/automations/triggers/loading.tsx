import { PageHeaderSkeleton, TableSkeleton } from "@/components/loading";

/**
 * Mirrors the triggers board: header (with the Create-trigger action) over the
 * streamed per-agent trigger table.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeaderSkeleton withAction />
      <TableSkeleton rows={6} cols={5} />
    </div>
  );
}
