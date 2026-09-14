import {
  LoadingRegion,
  PageHeaderSkeleton,
  CardGridSkeleton,
} from "@/components/loading";

export default function Loading() {
  return (
    <LoadingRegion label="Loading workspace" className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <CardGridSkeleton count={3} />
    </LoadingRegion>
  );
}
