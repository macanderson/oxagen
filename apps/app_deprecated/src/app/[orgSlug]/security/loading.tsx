import {
  LoadingRegion,
  PageHeaderSkeleton,
  CardGridSkeleton,
} from "@/components/loading";

export default function Loading() {
  return (
    <LoadingRegion label="Loading security" className="flex flex-col gap-6">
      <PageHeaderSkeleton />
      <CardGridSkeleton count={4} />
    </LoadingRegion>
  );
}
