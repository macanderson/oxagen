// The page's one h1, with an optional eyebrow, a description, metadata and an
// actions row that wraps under the title on a phone. Every page.tsx renders it
// with the same catalog key its generateMetadata returns (ARCHITECTURE.md §1.2),
// so the document title and the h1 cannot drift.
import type { ReactNode } from "react";
import { eyebrow as eyebrowStyle } from "./control-styles";

export type PageHeaderProps = {
  /** The translated `pages.*` title; the same string the page's generateMetadata returns. */
  title: string;
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
        {eyebrow ? <p className={eyebrowStyle}>{eyebrow}</p> : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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
