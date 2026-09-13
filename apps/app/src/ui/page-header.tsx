// The page's one h1, with an optional eyebrow, a description, metadata and an
// actions row that wraps under the title on a phone.
import type { ReactNode } from "react";

export type PageHeaderProps = {
  /** Already translated. */
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** Badges and facts that sit under the title (status, tier, owner). */
  meta?: ReactNode;
  actions?: ReactNode;
  /** A large figure beside the title, e.g. <Money variant="large"> for a run's cost (feedback 5). */
  figure?: ReactNode;
};

export function PageHeader({
  title,
  eyebrow,
  description,
  meta,
  actions,
  figure,
}: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow ? (
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <h1 className="min-w-0 text-2xl font-semibold leading-tight tracking-tight text-foreground">
            {title}
          </h1>
          {figure}
        </div>
        {description ? (
          <p className="max-w-prose text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
        {meta ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">{meta}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
