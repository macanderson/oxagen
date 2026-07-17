import { PageHeaderSkeleton, TableSkeleton } from "@/components/loading";

/**
 * Mirrors the automations list page: header (with the New-automation action)
 * over the streamed automation table, so the skeleton matches the real layout
 * instead of a bare header.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeaderSkeleton withAction />
      <TableSkeleton rows={6} cols={4} />
    </div>
  );
}
