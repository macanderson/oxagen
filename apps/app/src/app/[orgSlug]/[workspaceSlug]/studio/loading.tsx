import { LoadingRegion, PageHeaderSkeleton, CardGridSkeleton } from "@/components/loading";

export default function Loading() {
  return (
    <LoadingRegion label="Loading studio" className="flex flex-col gap-6 max-w-2xl">
      <PageHeaderSkeleton />
      <CardGridSkeleton count={4} />
    </LoadingRegion>
  );
}
