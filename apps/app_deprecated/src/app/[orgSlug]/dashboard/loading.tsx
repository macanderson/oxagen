/** Org dashboard loading skeleton — mirrors the stat-strip + panels layout. */
export default function OrgDashboardLoading() {
  return (
    <div
      className="flex flex-col gap-6"
      aria-busy="true"
      aria-label="Loading usage"
    >
      <div className="h-8 w-40 animate-pulse rounded-md bg-muted/50" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-muted/50" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-muted/50" />
        ))}
      </div>
      <div className="h-[300px] animate-pulse rounded-lg bg-muted/50" />
    </div>
  );
}
