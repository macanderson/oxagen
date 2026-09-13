import { Skeleton } from "@/components/ui/skeleton";

export default function SpendBudgetsLoading() {
  return (
    <div
      className="flex max-w-3xl flex-col gap-5"
      data-testid="spend-budgets-loading"
    >
      <Skeleton className="h-12 w-full rounded-lg" />
      <Skeleton className="h-48 w-full rounded-lg" />
      <Skeleton className="h-48 w-full rounded-lg" />
    </div>
  );
}
