// The frame every Billing panel shares (the mockup's `.panel`, `.panel-h` and
// `.panel-b`): a region named by its heading, an optional badge beside the
// heading, a body, the term-and-value list its facts print in, and the one
// date style the page uses. A panel whose body is a table sets `flush`, so the
// table meets the panel's edges the way the mockup draws it.
import { useTranslations } from "next-intl";
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
      <p className="border-l-2 border-gold/60 pl-3 text-[12.5px] text-muted-foreground">
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

/**
 * An RFC 3339 instant as the design prints a date, its UTC calendar day,
 * `2026-10-01`. A period ends at a UTC midnight, so printing it in the
 * viewer's zone would move the day for anyone west of Greenwich.
 */
export function isoDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export function useDate(): (iso: string) => string {
  return isoDate;
}

/** Whether [start, end) is one whole UTC calendar month. */
function calendarMonth(start: Date, end: Date): boolean {
  if (
    start.getUTCDate() !== 1 ||
    start.getUTCHours() !== 0 ||
    start.getUTCMinutes() !== 0 ||
    start.getUTCSeconds() !== 0
  ) {
    return false;
  }
  const next = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
  return end.getTime() === next;
}

/**
 * A billing period as the design prints it: the month ("August 2026") when
 * the period is one whole UTC calendar month, and the two dates otherwise, so
 * a period that straddles two months never reads as one of them.
 */
export function usePeriod(): (start: string, end: string) => string {
  const format = useFormatter();
  const t = useTranslations("billing");
  return (start, end) => {
    const from = new Date(start);
    const to = new Date(end);
    if (calendarMonth(from, to)) {
      return format.dateTime(from, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
    }
    return t("range", { start: isoDate(start), end: isoDate(end) });
  };
}
