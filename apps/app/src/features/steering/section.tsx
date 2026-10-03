// The frame every Steering section shares: a region named by its heading with
// an optional lead, the term-and-value list its facts print in, the pager for
// a page of proposals with Rows per page beside Previous and Next (#4693), and
// the one date style the page uses.
import { useLocale, useTranslations } from "next-intl";
import type { ComponentProps, ReactNode } from "react";
import type { SafePath } from "@/shared/safe-path";
import { panel } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { LinkPager } from "@/ui/link-pager";
import { formatCount } from "@/ui/money-format";
import { PROPOSAL_ROWS } from "./view";

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
      <h2 id={id} className="text-lg font-semibold text-foreground">
        {title}
      </h2>
      {lead === undefined ? null : (
        <p className="max-w-prose text-base text-muted-foreground">{lead}</p>
      )}
      {children}
    </section>
  );
}

export function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-base sm:grid-cols-rail">
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

/**
 * The pager under a page of proposals: Rows per page and the range on the
 * left, Previous and Next on the right, each an address `link` builds.
 * Picking a size opens the first page at that size. It draws while the page
 * holds a proposal or sits past the first, so a list that fits one page can
 * still be read ten at a time.
 */
export function Pager({
  offset,
  rows,
  shown,
  total,
  link,
}: {
  offset: number;
  /** How many proposals a page holds, one of PROPOSAL_ROWS. */
  rows: number;
  /** How many rows this page returned. */
  shown: number;
  total: number;
  link: (to: { offset: number; rows: number }) => SafePath;
}) {
  const t = useTranslations("steering.pager");
  const list = useTranslations("ui.list");
  const locale = useLocale();
  if (shown === 0 && offset === 0) return null;
  return (
    <LinkPager
      label={t("label")}
      rowsLabel={list("rows")}
      previousLabel={t("previous")}
      nextLabel={t("next")}
      perPage={rows}
      sizes={PROPOSAL_ROWS.map((size) => ({
        size,
        first: link({ offset: 0, rows: size }),
      }))}
      range={
        shown === 0
          ? undefined
          : t("range", {
              from: formatCount(offset + 1, locale),
              to: formatCount(offset + shown, locale),
              total: formatCount(total, locale),
            })
      }
      previous={
        offset > 0 ? link({ offset: Math.max(0, offset - rows), rows }) : null
      }
      next={
        offset + shown < total ? link({ offset: offset + rows, rows }) : null
      }
      className="px-0"
    />
  );
}
