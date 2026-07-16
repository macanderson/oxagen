import {
  PageHeaderSkeleton,
  DetailSkeleton,
  TableSkeleton,
} from "@/components/loading";

/**
 * Mirrors the automation detail/editor page: header, the two-column
 * trigger-config / playbook-steps grid, then the run-history table — so the
 * skeleton matches the real layout instead of a bare header.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton withAction />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border p-4">
          <DetailSkeleton />
        </div>
        <div className="rounded-lg border p-4">
          <DetailSkeleton />
        </div>
      </div>
      <TableSkeleton rows={4} cols={4} />
    </div>
  );
}
