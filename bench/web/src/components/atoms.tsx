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

export function Pill({
  active,
  color,
  children,
  onClick,
  disabled,
}: {
  readonly active: boolean;
  readonly color?: string;
  readonly children: React.ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        active
          ? "border-ember/60 bg-ember/15 text-graphite-100"
          : "border-graphite-700 bg-graphite-850 text-graphite-300 hover:border-graphite-600 hover:text-graphite-100",
      )}
    >
      {color ? (
        <span
          className="size-2.5 rounded-full"
          style={{ backgroundColor: active ? color : "transparent", borderColor: color, borderWidth: 1 }}
        />
      ) : null}
      {children}
    </button>
  );
}

export function Stat({
  label,
  value,
  accent,
}: {
  readonly label: string;
  readonly value: string;
  readonly accent?: boolean;
}): React.ReactElement {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-graphite-400">{label}</div>
      <div className={cn("mt-0.5 text-lg font-semibold tabular-nums", accent && "text-ember")}>
        {value}
      </div>
    </div>
  );
}
