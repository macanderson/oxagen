// No "use client" directive: these are presentational leaf components imported
// only into the client graph (via benchmark-dashboard), so they inherit the
// client boundary and don't need their own.
import { cn } from "@/lib/format";

export function Card({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      className={cn(
        "rounded-xl border border-graphite-700 bg-graphite-900/70 p-5 shadow-lg shadow-black/20",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  title,
  hint,
}: {
  readonly title: string;
  readonly hint?: string;
}): React.ReactElement {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-graphite-300">{title}</h2>
      {hint ? <span className="text-xs text-graphite-400">{hint}</span> : null}
    </div>
  );
}
