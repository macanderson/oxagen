import {
  LoadingRegion,
  PageHeaderSkeleton,
  DetailSkeleton,
} from "@/components/loading";

export default function Loading() {
  return (
    <LoadingRegion label="Loading" className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <DetailSkeleton />
    </LoadingRegion>
  );
}
