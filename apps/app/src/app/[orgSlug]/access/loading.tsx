import {
  LoadingRegion,
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/loading";

export default function Loading() {
  return (
    <LoadingRegion label="Loading access" className="flex flex-col gap-6">
      <PageHeaderSkeleton withAction />
      <TableSkeleton rows={6} />
    </LoadingRegion>
  );
}
