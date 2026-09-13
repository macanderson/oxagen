import {
  LoadingRegion,
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/loading";

export default function Loading() {
  return (
    <LoadingRegion
      label="Loading knowledge"
      className="flex flex-col gap-5 max-w-2xl"
    >
      <PageHeaderSkeleton withAction />
      <TableSkeleton rows={6} />
    </LoadingRegion>
  );
}
