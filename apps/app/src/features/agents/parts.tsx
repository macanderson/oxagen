// The pieces every Agents section is drawn from: a titled panel, a list of
// facts, a tile, an instant, the status dot and word, the not-recorded words
// and a pager. Presentational; each section passes translated text.
import { useTranslations } from "next-intl";
import { Fragment, type ReactNode } from "react";
import type { AgentStatus } from "@/data/contracts/agents";
import type { SafePath } from "@/shared/safe-path";
import {
  linkText,
  panel,
  panelHeader,
  statNote,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { useFormatter } from "@/ui/formatter";

export function Panel({
  id,
  title,
  lead,
  children,
}: {
  /** The heading's id, unique on the page. */
  id: string;
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`${panel} flex min-w-0 flex-col gap-3 p-4`}
    >
      <div
        className={`${panelHeader} -mx-4 -mt-4 flex-col items-start gap-0.5`}
      >
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
        {lead === undefined ? null : (
          <p className="text-xs text-muted-foreground">{lead}</p>
        )}
      </div>
      {children}
    </section>
  );
}

export function Facts({
  rows,
}: {
  rows: readonly { term: string; value: ReactNode }[];
}) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr]">
      {rows.map((row) => (
        <Fragment key={row.term}>
          <dt className="text-muted-foreground">{row.term}</dt>
          <dd className="min-w-0 break-words pb-2 sm:pb-0">{row.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function Tile({
  title,
  value,
  basis,
  critical = false,
}: {
  title: string;
  value: ReactNode;
  basis: ReactNode;
  /** The critical hue on the figure (`.stat .v.crit`), for a count that is a problem when it is not zero. */
  critical?: boolean;
}) {
  return (
    <dl data-testid="tile" className={statTile}>
      <dt className={statTerm}>{title}</dt>
      <dd
        data-critical={critical ? "true" : undefined}
        className={`${statValue} ${critical ? "text-critical" : ""}`}
      >
        {value}
      </dd>
      <dd className={statNote}>{basis}</dd>
    </dl>
  );
}

export function Instant({ at }: { at: string }) {
  const format = useFormatter();
  return (
    <time dateTime={at}>
      {format.dateTime(new Date(at), {
        dateStyle: "medium",
        timeStyle: "short",
      })}
    </time>
  );
}

/** The backend gaps a list cell can name when it prints not recorded. */
type ListGap =
  | "steering"
  | "toolbelt"
  | "belt"
  | "tokens"
  | "commit"
  | "organization"
  | "tier"
  | "runtimeKind";

/**
 * A value the store did not record. With `gap`, the cell names the missing
 * store on hover and carries it as `data-gap`, so an unbacked column says what
 * it is waiting for rather than only that it is empty.
 */
export function NotRecordedValue({ gap }: { gap?: ListGap } = {}) {
  const t = useTranslations("agents");
  return (
    <span
      data-gap={gap}
      title={gap === undefined ? undefined : t(`list.gaps.${gap}`)}
      className="text-muted-foreground"
    >
      {t("notRecorded")}
    </span>
  );
}

const STATUS_DOT: Record<AgentStatus, string> = {
  enrolled: "bg-success",
  unenrolled: "bg-muted-foreground",
  suspended: "bg-warning",
  retired: "bg-muted-foreground",
};

/** The identity's state as a dot and a word, so it survives greyscale. */
export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const t = useTranslations("agents.status");
  return (
    <span
      data-status={status}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground"
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${STATUS_DOT[status]}`}
      />
      {t(status)}
    </span>
  );
}

export function Pager({
  label,
  first,
  next,
}: {
  label: string;
  /** The first page and its link text, when a later page is shown. */
  first: { to: SafePath; text: string } | null;
  /** The next page and its link text, when one exists. */
  next: { to: SafePath; text: string } | null;
}) {
  if (first === null && next === null) return null;
  return (
    <nav aria-label={label} className="flex gap-4 pt-3 text-sm">
      {first === null ? null : (
        <SafeLink to={first.to} className={linkText}>
          {first.text}
        </SafeLink>
      )}
      {next === null ? null : (
        <SafeLink to={next.to} className={linkText}>
          {next.text}
        </SafeLink>
      )}
    </nav>
  );
}
