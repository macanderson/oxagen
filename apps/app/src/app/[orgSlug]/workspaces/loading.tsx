import {
  LoadingRegion,
  PageHeaderSkeleton,
  CardGridSkeleton,
} from "@/components/loading";

export default function Loading() {
  return (
    <LoadingRegion label="Loading workspaces" className="flex flex-col gap-6">
      <PageHeaderSkeleton withAction />
      <CardGridSkeleton count={6} />
    </LoadingRegion>
  );
}
