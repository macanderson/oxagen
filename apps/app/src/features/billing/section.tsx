// The frame every Billing section shares: a region named by its heading, the
// term-and-value list its facts print in, and the one date style the page
// uses.
import { useFormatter } from "next-intl";
import type { ComponentProps, ReactNode } from "react";
import { panel } from "@/ui/control-styles";

export function Section({
  id,
  title,
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
}) {
  return (
    <section
      aria-labelledby={id}
      className={`${panel} flex flex-col gap-3 p-5`}
      {...rest}
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

/** An RFC 3339 instant as a medium date in the viewer's locale and time zone. */
export function useDate(): (iso: string) => string {
  const format = useFormatter();
  return (iso) => format.dateTime(new Date(iso), { dateStyle: "medium" });
}
