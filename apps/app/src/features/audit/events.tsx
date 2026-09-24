// Audit › Events (rev1 audit.md, Events): four tiles over the window, then the
// "Control-plane events" panel with its filters, the table and the note.
//
// The tiles count the rows of one read of the window (query_audit_log, up to
// the contract's 200), through the same outcome the table prints, so the strip
// and the list cannot tell different stories. A window holding more than one
// read returns shows its counts as a lower bound, `200+`, never as a total.
// Two tiles need an actor kind and the record carries none, so they say
// "not recorded" rather than a zero, and so does every Severity cell. The
// agent tile drops the design's basis line ("each one a governed action with a
// receipt") while it is not recorded: no receipt store exists (#3875), so the
// line would claim what the record does not hold.
//
// The Actor filter is the design's actor kinds. The record carries no kind
// (#3873), so Humans, Agents and Services are drawn and disabled beside the
// sentence that says why. A link that names one person (`?actor=usr_…`) still
// narrows the read, and the select shows that person so the filter it applied
// is visible and can be cleared.
import "server-only";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  AUDIT_RANGES,
  AUDIT_ROWS,
  type AuditEvent,
  type AuditPage,
  type AuditQuery,
} from "@/data/contracts/audit";
import { routes } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import {
  buttonSecondary,
  inputBase,
  mono,
  panel,
  panelHeader,
  panelTitle,
  statNote,
  statStrip,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { formatCount } from "@/ui/money-format";
import { SafeForm, SafeLink } from "@/ui/navigation";
import { type PageListItem, pageList, pagerButton } from "@/ui/page-list";
import { cell, Table } from "@/ui/table";
import { CsvDialog } from "./dialogs";
import { FilterSelect } from "./filter-select";
import { AUDIT_OUTCOMES, auditQueryParams } from "./filters";
import { AUDIT_GAPS } from "./gaps";

/** An actor the record names, as the filter and the table print them. */
export type AuditActor = { id: string; name: string };

/** The window's rows as the tiles count them: the events, and whether the read held all of them. */
export type AuditWindowRows = {
  events: readonly AuditEvent[];
  complete: boolean;
};

/** How many rows a count covers: exact when the read held the window, a lower bound when it did not. */
function Count({ n, complete }: { n: number; complete: boolean }) {
  const t = useTranslations("audit.tiles");
  const value = formatCount(n, useLocale());
  return <>{complete ? value : t("atLeast", { count: value })}</>;
}

function NotRecordedValue() {
  const t = useTranslations("audit");
  return (
    <span data-recorded="false" className="text-muted-foreground">
      {t("notRecorded")}
    </span>
  );
}

function Tile({
  term,
  note,
  children,
}: {
  term: string;
  /** The basis line; left out where the record cannot back one. */
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className={statTile}>
      <dt className={statTerm}>{term}</dt>
      <dd className={statValue}>{children}</dd>
      {note === undefined ? null : <dd className={statNote}>{note}</dd>}
    </div>
  );
}

export function EventTiles({
  query,
  window: rows,
}: {
  query: AuditQuery;
  window: AuditWindowRows;
}) {
  const t = useTranslations("audit.tiles");
  const denied = rows.events.filter((event) => event.outcome === "deny").length;
  const days = query.from !== null || query.to !== null;
  return (
    <dl aria-label={t("label")} className={statStrip}>
      <Tile
        term={
          days
            ? t("eventsDays")
            : t(
                query.range === "48h"
                  ? "events48h"
                  : query.range === "7d"
                    ? "events7d"
                    : "events30d",
              )
        }
        note={t("eventsNote")}
      >
        <Count n={rows.events.length} complete={rows.complete} />
      </Tile>
      <Tile term={t("denied")} note={t("deniedNote")}>
        <Count n={denied} complete={rows.complete} />
      </Tile>
      <Tile term={t("service")} note={t("serviceNote")}>
        <NotRecordedValue />
      </Tile>
      <Tile term={t("agent")}>
        <NotRecordedValue />
      </Tile>
    </dl>
  );
}

const TONE: Record<NonNullable<AuditEvent["outcome"]>, BadgeTone> = {
  allow: "allowed",
  success: "allowed",
  deny: "denied",
  error: "failed",
};

/** The result as a dot and a word, so it survives greyscale. */
function Outcome({ outcome }: { outcome: AuditEvent["outcome"] }) {
  const t = useTranslations("audit.outcomes");
  if (outcome === null) return <NotRecordedValue />;
  return (
    <Badge tone={TONE[outcome]} data-outcome={outcome}>
      {t(outcome)}
    </Badge>
  );
}

function When({ iso }: { iso: string }) {
  const format = useFormatter();
  return (
    <time dateTime={iso} className={`${mono} whitespace-nowrap text-dim`}>
      {format.dateTime(new Date(iso), {
        dateStyle: "medium",
        timeStyle: "medium",
      })}
    </time>
  );
}

const label = "sr-only";
/** The design's actor kinds (audit.md, Events), none of which the record carries yet. */
const ACTOR_KINDS = ["human", "agent", "service"] as const;
// The design's Severity filter (rev1 audit.md, Events). The select stays
// disabled with its note until an audit event records a severity.
const AUDIT_SEVERITIES = ["critical", "info", "warning"] as const;
const ACTOR_KIND_NOTE = "audit-actor-kind-note";
/**
 * A 44 px tap target and 16 px text on a phone (rev1 audit.md, Mobile): the
 * house input is about 38 px tall, and 16 px keeps the browser from zooming
 * the page when the field takes focus.
 */
const control = `${inputBase} max-md:min-h-11 max-md:text-base`;
const select = `${control} w-auto`;

function Filters({ org, query }: { org: string; query: AuditQuery }) {
  const t = useTranslations("audit.events");
  const outcomes = useTranslations("audit.outcomes");
  const searchNote = "audit-search-note";
  return (
    <SafeForm
      action={routes.audit(org)}
      method="get"
      aria-label={t("filters")}
      data-testid="audit-filters"
      className="flex flex-col gap-2 border-b border-border px-4 py-3"
    >
      <span className="flex flex-wrap items-center gap-2">
        <label className="min-w-48 flex-1">
          <span className={label}>{t("search")}</span>
          <input
            type="search"
            disabled
            placeholder={t("searchPlaceholder")}
            aria-describedby={searchNote}
            className={control}
          />
        </label>
        <label>
          <span className={label}>{t("result")}</span>
          <FilterSelect
            name="outcome"
            defaultValue={query.outcome ?? ""}
            className={select}
          >
            <option value="">{t("anyResult")}</option>
            {AUDIT_OUTCOMES.filter(
              (outcome) => outcome === "allow" || outcome === "deny",
            ).map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcomes(outcome)}
              </option>
            ))}
          </FilterSelect>
        </label>
        <label>
          <span className={label}>{t("severity")}</span>
          <select
            disabled
            defaultValue=""
            aria-describedby="audit-severity-note"
            className={select}
          >
            <option value="">{t("anySeverity")}</option>
            {AUDIT_SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {t(`severities.${severity}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t("rows")}
          <FilterSelect
            name="rows"
            defaultValue={String(query.rows)}
            className={select}
          >
            {AUDIT_ROWS.map((rows) => (
              <option key={rows} value={rows}>
                {rows}
              </option>
            ))}
          </FilterSelect>
        </label>
        <noscript>
          <button type="submit" className={buttonSecondary}>
            {t("apply")}
          </button>
        </noscript>
      </span>
      {/* The actor and range the header's selects set travel with this form
          too, so changing a result keeps them. */}
      {query.actor === null ? null : (
        <input type="hidden" name="actor" value={query.actor} />
      )}
      {query.range === "30d" ? null : (
        <input type="hidden" name="range" value={query.range} />
      )}
      <span
        data-testid="audit-not-recorded"
        data-issue={AUDIT_GAPS.events.issue}
        className="flex flex-col gap-0.5 text-xs text-muted-foreground"
      >
        <span id={ACTOR_KIND_NOTE}>{t("actorKindNotRecorded")}</span>
        <span id={searchNote}>{t("searchNotRecorded")}</span>
        <span id="audit-severity-note">{t("severityNotRecorded")}</span>
      </span>
    </SafeForm>
  );
}

/** Actor and Range sit in the panel header, as the design draws them. */
function HeaderFilters({
  org,
  query,
  actors,
}: {
  org: string;
  query: AuditQuery;
  actors: readonly AuditActor[];
}) {
  const t = useTranslations("audit.events");
  const picked =
    query.actor === null
      ? null
      : {
          id: query.actor,
          name:
            actors.find((actor) => actor.id === query.actor)?.name ??
            query.actor,
        };
  return (
    <SafeForm
      action={routes.audit(org)}
      method="get"
      aria-label={t("filters")}
      className="flex flex-wrap items-center gap-2"
    >
      <label>
        <span className={label}>{t("actor")}</span>
        <FilterSelect
          name="actor"
          defaultValue={query.actor ?? ""}
          aria-describedby={ACTOR_KIND_NOTE}
          className={select}
        >
          <option value="">{t("anyActor")}</option>
          {ACTOR_KINDS.map((kind) => (
            <option key={kind} value={`kind:${kind}`} disabled>
              {t(`actorKinds.${kind}`)}
            </option>
          ))}
          {picked === null ? null : (
            <option value={picked.id}>{picked.name}</option>
          )}
        </FilterSelect>
      </label>
      <label>
        <span className={label}>{t("range")}</span>
        <FilterSelect
          name="range"
          defaultValue={query.range}
          className={select}
        >
          {AUDIT_RANGES.map((range) => (
            <option key={range} value={range}>
              {t(`ranges.${range}`)}
            </option>
          ))}
        </FilterSelect>
      </label>
      {query.outcome === null ? null : (
        <input type="hidden" name="outcome" value={query.outcome} />
      )}
      {query.rows === 10 ? null : (
        <input type="hidden" name="rows" value={query.rows} />
      )}
      <noscript>
        <button type="submit" className={buttonSecondary}>
          {t("apply")}
        </button>
      </noscript>
    </SafeForm>
  );
}

function EventsTable({
  events,
  actors,
}: {
  events: readonly AuditEvent[];
  actors: readonly AuditActor[];
}) {
  const t = useTranslations("audit.events");
  const names = new Map(actors.map((actor) => [actor.id, actor.name]));
  return (
    <Table
      label={t("title")}
      columns={[
        { label: t("when") },
        { label: t("event") },
        { label: t("actor") },
        { label: t("what") },
        { label: t("result") },
        { label: t("severity") },
        { label: t("reference") },
      ]}
    >
      {/* The view model carries no event id: the security event's own id is a
          database uuid with no public form (INV-11), so the row's key is what
          the record did fill. A request id alone repeats across the rows of one
          invoke, so every recorded field joins it. */}
      {events.map((event) => (
        <tr
          key={[
            event.occurredAt,
            event.eventType,
            event.actor,
            event.capability,
            event.request,
            event.ip,
          ].join("|")}
        >
          <td className={cell}>
            <When iso={event.occurredAt} />
          </td>
          <td className={`${cell} ${mono}`}>{event.eventType}</td>
          <td className={cell}>
            <span className="flex flex-col">
              {event.actor === null ? (
                <NotRecordedValue />
              ) : (
                (names.get(event.actor) ?? (
                  <span className={mono}>{event.actor}</span>
                ))
              )}
              <span className="text-xs text-muted-foreground">
                {t("kindNotRecorded")}
              </span>
            </span>
          </td>
          <td className={`${cell} max-w-[38ch]`}>
            <span className={mono}>
              {event.capability ?? <NotRecordedValue />}
            </span>
            {event.detail == null ? null : (
              // The stored evidence the event carries (#3554): approval-rule
              // invalidation facts and the SSO and governance details.
              <details className="pt-1 text-xs">
                <summary className="cursor-pointer text-muted-foreground max-md:inline-flex max-md:min-h-11 max-md:items-center">
                  {t("detail")}
                </summary>
                <pre className="max-w-prose whitespace-pre-wrap break-all pt-1 font-mono">
                  {JSON.stringify(event.detail, null, 2)}
                </pre>
              </details>
            )}
          </td>
          <td className={cell}>
            <Outcome outcome={event.outcome} />
          </td>
          <td className={cell}>
            <NotRecordedValue />
          </td>
          <td className={`${cell} ${mono} text-dim`}>
            {event.request ?? <NotRecordedValue />}
          </td>
        </tr>
      ))}
    </Table>
  );
}

/**
 * How many events the filters select: the window's rows through the same
 * result filter the table applies. It is exact only when the window read held
 * every row, so the pager draws a total and the CSV dialog a bare count only
 * then.
 */
function selected(query: AuditQuery, rows: AuditWindowRows): number {
  return rows.events.filter(
    (event) => query.outcome === null || event.outcome === query.outcome,
  ).length;
}

/**
 * Where this page sits in the filtered record, and the design's numbered pager
 * (`‹ 1 2 … 45 ›`), each page a link at the Rows size that keeps the filters.
 * The page count is known only when the window read held every row; when it
 * did not, the pager numbers the pages read so far, then the next page and an
 * ellipsis while an older page exists, and claims no last page.
 */
function Pager({
  org,
  query,
  page,
  window: rows,
}: {
  org: string;
  query: AuditQuery;
  page: AuditPage;
  window: AuditWindowRows;
}) {
  const t = useTranslations("audit.events");
  const start = page.events.length === 0 ? 0 : page.offset + 1;
  const end = page.offset + page.events.length;
  const total = rows.complete ? selected(query, rows) : null;
  const size = Math.max(1, page.limit);
  const current = Math.floor(page.offset / size) + 1;
  const pages =
    total === null
      ? current + (page.hasMore ? 1 : 0)
      : Math.max(current, Math.ceil(total / size));
  const numbers: (PageListItem | "more")[] = pageList(current, pages);
  if (total === null && page.hasMore) numbers.push("more");
  const hasOlder = total === null ? page.hasMore : current < pages;
  const to = (n: number) =>
    routes.audit(org, auditQueryParams(query, { offset: (n - 1) * size }));
  return (
    <nav
      aria-label={t("pager")}
      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs text-muted-foreground"
    >
      <span data-testid="audit-shown" className={mono}>
        {total === null
          ? t("shownOpen", { start, end })
          : t("shown", { start, end, total })}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        {current > 1 ? (
          <SafeLink
            to={to(current - 1)}
            data-page="previous"
            aria-label={t("previous")}
            className={pagerButton}
          >
            ‹
          </SafeLink>
        ) : (
          <button
            type="button"
            disabled
            aria-label={t("previous")}
            className={pagerButton}
          >
            ‹
          </button>
        )}
        {numbers.map((n) =>
          typeof n === "string" ? (
            <span key={n} aria-hidden="true" className="px-1 text-dim">
              …
            </span>
          ) : (
            <SafeLink
              key={n}
              to={to(n)}
              data-page={n}
              aria-current={n === current ? "page" : undefined}
              className={pagerButton}
            >
              {n}
            </SafeLink>
          ),
        )}
        {hasOlder ? (
          <SafeLink
            to={to(current + 1)}
            data-page="next"
            aria-label={t("next")}
            className={pagerButton}
          >
            ›
          </SafeLink>
        ) : (
          <button
            type="button"
            disabled
            aria-label={t("next")}
            className={pagerButton}
          >
            ›
          </button>
        )}
      </span>
    </nav>
  );
}

export function EventsPanel({
  org,
  query,
  page,
  window: rows,
  actors,
}: {
  org: string;
  query: AuditQuery;
  page: AuditPage;
  window: AuditWindowRows;
  actors: readonly AuditActor[];
}) {
  const t = useTranslations("audit.events");
  const tiles = useTranslations("audit.tiles");
  const locale = useLocale();
  const count = selected(query, rows);
  return (
    <section
      aria-labelledby="audit-events"
      className={`${panel} flex flex-col`}
    >
      <header className={panelHeader}>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="audit-events" className={panelTitle}>
            {t("title")}
          </h2>
          <span className="text-[12.5px] text-muted-foreground">
            {t("caption")}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone="quiet" dot={false} mono>
            {t("store")}
          </Badge>
          <HeaderFilters org={org} query={query} actors={actors} />
          <CsvDialog
            href={routes.auditExport(
              org,
              auditQueryParams(query, { offset: 0, format: "csv" }),
            )}
            count={
              rows.complete
                ? formatCount(count, locale)
                : tiles("atLeast", { count: formatCount(count, locale) })
            }
            n={count}
            range={
              query.from !== null || query.to !== null ? "days" : query.range
            }
          />
        </span>
      </header>
      <Filters org={org} query={query} />
      {page.events.length === 0 ? (
        <p
          data-state="filtered-empty"
          className="px-4 py-8 text-[13px] text-muted-foreground"
        >
          {t("none")}
        </p>
      ) : (
        <EventsTable events={page.events} actors={actors} />
      )}
      <Pager org={org} query={query} page={page} window={rows} />
      <p className="mx-4 mb-4 border-l-2 border-gold pl-3 text-[13px] text-muted-foreground">
        {t("note")}
      </p>
    </section>
  );
}
