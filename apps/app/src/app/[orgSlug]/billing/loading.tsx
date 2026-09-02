import {
  LoadingRegion,
  PageHeaderSkeleton,
  StatCardsSkeleton,
  CardGridSkeleton,
} from "@/components/loading";

export default function Loading() {
  return (
    <LoadingRegion label="Loading billing" className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <StatCardsSkeleton />
      <CardGridSkeleton count={3} />
    </LoadingRegion>
  );
}
