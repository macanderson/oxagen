// The frame every Billing panel shares (the mockup's `.panel`, `.panel-h` and
// `.panel-b`): a region named by its heading, an optional badge beside the
// heading, a body, the term-and-value list its facts print in, and the one
// date style the page uses. A panel whose body is a table sets `flush`, so the
// table meets the panel's edges the way the mockup draws it.
import type { ComponentProps, ReactNode } from "react";
import { panel, panelBody, panelHeader, panelTitle } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";

export function Section({
  id,
  title,
  badge,
  flush = false,
  children,
  ...rest
}: Omit<
  ComponentProps<"section">,
  "id" | "title" | "className" | "aria-labelledby"
> & {
  /** The heading's id; unique on the page. */
  id: string;
  /** The translated section title. */
  title: string;
  /** A badge beside the heading: what the panel's figures come from. */
  badge?: ReactNode;
  /** The body is a table that runs to the panel's edges. */
  flush?: boolean;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`${panel} flex flex-col`}
      {...rest}
    >
      <div className={panelHeader}>
        <h2 id={id} className={panelTitle}>
          {title}
        </h2>
        {badge}
      </div>
      <div
        className={flush ? "flex flex-col" : `${panelBody} flex flex-col gap-3`}
      >
        {children}
      </div>
    </section>
  );
}

/** A panel's closing note under its table (the mockup's `.panel-b .note`). */
export function PanelNote({ children }: { children: ReactNode }) {
  return (
    <div className={panelBody}>
      <p className="border-l-2 border-primary/60 pl-3 text-[12.5px] text-muted-foreground">
        {children}
      </p>
    </div>
  );
}

export function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
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
      <dd className="min-w-0 break-words text-foreground tabular-nums">
        {children}
      </dd>
    </div>
  );
}

/** A figure nothing records yet: it says so, and never prints a zero in its place. */
export function NotRecordedValue({ children }: { children: ReactNode }) {
  return (
    <span data-recorded="false" className="text-muted-foreground">
      {children}
    </span>
  );
}

/** An RFC 3339 instant as a medium date in the viewer's locale and time zone. */
export function useDate(): (iso: string) => string {
  const format = useFormatter();
  return (iso) => format.dateTime(new Date(iso), { dateStyle: "medium" });
}
