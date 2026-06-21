import { LoadingRegion, PageHeaderSkeleton, CardGridSkeleton } from "@/components/loading";

export default function Loading() {
  return (
    <LoadingRegion label="Loading automation" className="flex flex-col gap-6">
      <PageHeaderSkeleton withAction />
      <CardGridSkeleton count={3} />
    </LoadingRegion>
  );
}
