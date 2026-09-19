// The pieces every Tools tab shares: the section frame, the term-and-value
// list, the one date style, the cursor pager, and the badges that carry state
// as a dot and a word so they survive greyscale (the mockup's rule: gold is
// identity, never state).
import { useTranslations } from "next-intl";
import type { ComponentProps, ReactNode } from "react";
import type { SafePath } from "@/shared/safe-path";
import { linkText, mono, panel } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { useFormatter } from "@/ui/formatter";

export function Section({
  id,
  title,
  lead,
  actions,
  children,
  ...rest
}: Omit<
  ComponentProps<"section">,
  "id" | "title" | "className" | "aria-labelledby"
> & {
  id: string;
  title: string;
  lead?: string;
  actions?: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`${panel} flex flex-col gap-3 p-5`}
      {...rest}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={id} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          {lead === undefined ? null : (
            <p className="max-w-prose text-sm text-muted-foreground">{lead}</p>
          )}
        </div>
        {actions === undefined ? null : (
          <div className="flex flex-none flex-wrap gap-2">{actions}</div>
        )}
      </div>
      {children}
    </section>
  );
}

export function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
      {children}
    </dl>
  );
}

export function Fact({
  name,
  term,
  children,
}: {
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

const TONE = {
  neutral: "bg-muted-foreground",
  ok: "bg-success",
  warn: "bg-warning",
  deny: "bg-destructive",
} as const;
export type Tone = keyof typeof TONE;

/** State as a dot and a word: the hue sits on the dot, the word stays on the ink. */
export function StateDot({
  tone,
  label,
  name,
}: {
  tone: Tone;
  label: string;
  /** A stable name for the state, carried as `data-state`. */
  name: string;
}) {
  return (
    <span
      data-state={name}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground"
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${TONE[tone]}`}
      />
      {label}
    </span>
  );
}

/** A value read straight off the record, in the mono face: a tag, a digest, an id. */
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span
      className={`${mono} inline-flex items-center rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground`}
    >
      {children}
    </span>
  );
}

/** What a read did not carry, said once and the same way everywhere (INV-10). */
export function NotCarried() {
  const t = useTranslations("tools");
  return (
    <span data-not-carried="" className="text-xs text-muted-foreground">
      {t("notCarried")}
    </span>
  );
}

/** The next cursor page of a list; nothing when the read carried the last one. */
export function CursorPager({
  nextCursor,
  link,
}: {
  nextCursor: string | null;
  link: (cursor: string) => SafePath;
}) {
  const t = useTranslations("tools");
  if (nextCursor === null) return null;
  return (
    <SafeLink
      to={link(nextCursor)}
      data-testid="tools-next-page"
      className={linkText}
    >
      {t("nextPage")}
    </SafeLink>
  );
}
