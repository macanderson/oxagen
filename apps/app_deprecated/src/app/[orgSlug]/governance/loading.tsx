import {
  StatCardsSkeleton,
  CardGridSkeleton,
  TableSkeleton,
} from "@/components/loading";

/**
 * Mirrors the governance hub: the three summary stat tiles, the six-card
 * accountability-chain grid, then the recent-denied-invocations panel — so the
 * skeleton matches the real layout instead of a bare header.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <StatCardsSkeleton count={3} />
      <CardGridSkeleton count={6} />
      <TableSkeleton rows={4} cols={4} />
    </div>
  );
}
