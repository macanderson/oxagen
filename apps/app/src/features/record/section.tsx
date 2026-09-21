// The frame the record page's metadata panels share, and the one date style
// the page uses. Each feature folder carries its own copy of this frame
// (features/steering/section.tsx, features/billing/section.tsx) because a
// feature exposes only its index and never reaches into another's files.
import type { ReactNode } from "react";
import { panel } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";

export function Section({
  id,
  title,
  children,
}: {
  /** The heading's id; unique on the page. */
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      // The heading's id doubles as the panel's test id: it is already unique
      // on the page, so a second name for the same panel would only drift.
      data-testid={id}
      className={`${panel} flex flex-col gap-3 p-5`}
    >
      <h2 id={id} className="text-base font-semibold text-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
      {children}
    </dl>
  );
}

export function Fact({
  name,
  term,
  children,
}: {
  /** A stable name for the fact, carried as `data-fact`. */
  name: string;
  term: string;
  children: ReactNode;
}) {
  return (
    <div data-fact={name} className="contents">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

/** An RFC 3339 instant as a medium date and time in the viewer's locale and zone. */
export function useDate(): (iso: string) => string {
  const format = useFormatter();
  return (iso) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
}
