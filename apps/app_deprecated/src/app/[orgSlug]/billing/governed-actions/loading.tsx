/**
 * loading.tsx — the loading state for the governed-action meter.
 *
 * Skeletons matched to the final layout (usage stats, then two tables, then the
 * calculator form) so the page does not jump when the reads land.
 */

import {
  LoadingRegion,
  StatCardsSkeleton,
  CardGridSkeleton,
} from "@/components/loading";

export default function Loading() {
  return (
    <LoadingRegion
      label="Loading governed actions"
      className="flex flex-col gap-6"
    >
      <StatCardsSkeleton />
      <CardGridSkeleton count={2} />
      <StatCardsSkeleton />
    </LoadingRegion>
  );
}
