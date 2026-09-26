// The pieces every Agents section is drawn from: a titled panel, a list of
// facts, a tile, an instant, the status dot and word, the not-recorded words
// and a pager. Presentational; each section passes translated text.
import { useTranslations } from "next-intl";
import { Fragment, type ReactNode } from "react";
import type { AgentStatus } from "@/data/contracts/agents";
import type { SafePath } from "@/shared/safe-path";
import {
  buttonSecondary,
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

/**
 * `.btn.danger`: the hairline and the ink in the error hue, for a write that
 * ends something (Suspend, Deregister, Revoke credential, Unenroll). It is
 * never the gold: gold is identity.
 */
export const buttonDanger = `${buttonSecondary} border-error/40 text-error-ink hover:border-error/60 hover:bg-error/10`;

export function Panel({
  id,
  title,
  lead,
  aside,
  tone,
  testId,
  children,
}: {
  /** The heading's id, unique on the page. */
  id: string;
  title: string;
  /** The one sentence under the heading. */
  lead?: ReactNode;
  /** What sits at the right of the header: a badge, a count, a button. */
  aside?: ReactNode;
  /** A panel whose edge carries a state hue (the mockup's tinted border). */
  tone?: "proven" | "critical" | "approval";
  testId?: string;
  children: ReactNode;
}) {
  const edge =
    tone === "proven"
      ? "border-proven/35"
      : tone === "critical"
        ? "border-critical/35"
        : tone === "approval"
          ? "border-info/35"
          : "";
  return (
    <section
      aria-labelledby={id}
      data-testid={testId}
      className={`${panel} ${edge} flex min-w-0 flex-col gap-3 p-4`}
    >
      <div
        className={`${panelHeader} -mx-4 -mt-4 flex-nowrap items-start bg-hl`}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id={id} className="text-[13.5px] font-semibold">
            {title}
          </h2>
          {lead === undefined ? null : (
            <p className="text-xs text-muted-foreground">{lead}</p>
          )}
        </div>
        {aside === undefined ? null : (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {aside}
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * A slice the design draws whose store Oxagen does not have yet. It says what
 * is missing in words, and carries the backend gap as data, so it can never be
 * read as a zero or as a finding that nothing happened.
 */
export function NotBacked({
  gap,
  children,
}: {
  /** The backend gap, as the spec's data-source table names it. */
  gap: string;
  children: ReactNode;
}) {
  return (
    <p
      data-testid="not-backed"
      data-gap={gap}
      className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
    >
      {children}
    </p>
  );
}

/** A fact with the one quiet line under it (the mockup's `dd .sub`). */
export function Sub({ children }: { children: ReactNode }) {
  return (
    <span className="mt-0.5 block text-xs text-muted-foreground">
      {children}
    </span>
  );
}

/** The mockup's `.note`: a gold rule at the left and one or two sentences. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="border-l-2 border-gold py-1 pl-3 text-[12.5px] text-muted-foreground">
      {children}
    </p>
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
  | "belt"
  | "tokens"
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
