import { LoadingRegion, PageHeaderSkeleton, TableSkeleton } from "@/components/loading";

export default function Loading() {
  return (
    <LoadingRegion label="Loading activity" className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <TableSkeleton rows={6} />
    </LoadingRegion>
  );
}
