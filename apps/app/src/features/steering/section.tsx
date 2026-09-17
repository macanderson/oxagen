// The frame every Steering section shares: a region named by its heading with
// an optional lead, the term-and-value list its facts print in, the pager for
// a page of records or proposals, and the one date style the page uses.
import { useFormatter, useLocale, useTranslations } from "next-intl";
import type { ComponentProps, ReactNode } from "react";
import { STEERING_PAGE } from "@/data/contracts/steering";
import type { SafePath } from "@/shared/safe-path";
import { linkText, panel } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";

export function Section({
  id,
  title,
  lead,
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
  lead?: string;
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
      {lead === undefined ? null : (
        <p className="max-w-prose text-sm text-muted-foreground">{lead}</p>
      )}
      {children}
    </section>
  );
}

export function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
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

/** An RFC 3339 instant as a medium date and time in the viewer's locale and time zone. */
export function useDate(): (iso: string) => string {
  const format = useFormatter();
  return (iso) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
}

/** Previous and next pages of a list read `STEERING_PAGE` at a time; nothing when one page holds it all. */
export function Pager({
  offset,
  shown,
  total,
  link,
}: {
  offset: number;
  /** How many rows this page returned. */
  shown: number;
  total: number;
  link: (offset: number) => SafePath;
}) {
  const t = useTranslations("steering.pager");
  const locale = useLocale();
  const hasPrevious = offset > 0;
  const hasNext = offset + shown < total;
  if (!hasPrevious && !hasNext) return null;
  return (
    <nav
      aria-label={t("label")}
      className="flex flex-wrap items-center gap-4 text-sm"
    >
      {shown === 0 ? null : (
        <span className="text-muted-foreground">
          {t("range", {
            from: formatCount(offset + 1, locale),
            to: formatCount(offset + shown, locale),
            total: formatCount(total, locale),
          })}
        </span>
      )}
      {hasPrevious ? (
        <SafeLink
          to={link(Math.max(0, offset - STEERING_PAGE))}
          className={linkText}
        >
          {t("previous")}
        </SafeLink>
      ) : null}
      {hasNext ? (
        <SafeLink to={link(offset + STEERING_PAGE)} className={linkText}>
          {t("next")}
        </SafeLink>
      ) : null}
    </nav>
  );
}
