// The Audit page's one section (#3097; ARCHITECTURE.md §1.2): the
// organization's control-plane events from query_audit_log, filtered in the
// URL, paged by offset, and exported as the signed file export_audit_events
// answers. Both reads are noBillingGate kernel reads through the audit port;
// actor names come from the members read the Organization page already makes.
//
// What the record does not carry is not drawn: there are no summary tiles, no
// severity and no reference column, because no column behind them exists. A
// refused read renders the denied state, never an empty record.
import "server-only";
import { useTranslations } from "next-intl";
import type { AuditEvent, AuditPage, AuditQuery } from "@/data/contracts/audit";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { OrgCtx, OrgRole } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { buttonSecondary, linkText, mono, panel } from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { SafeForm, SafeLink } from "@/ui/navigation";
import { cell, Table } from "@/ui/table";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_OUTCOMES,
  auditQueryParams,
  auditWindow,
  hasAuditFilters,
  parseAuditQuery,
} from "./filters";
import { useFormatter } from "@/ui/formatter";

/** An actor the record names, as the filter and the table print them. */
type AuditActor = { id: string; name: string };

export async function Audit({
  ctx,
  source,
  searchParams,
}: {
  ctx: OrgCtx;
  source: DataSource;
  searchParams: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const query = parseAuditQuery(searchParams);
  const { offset, ...filters } = query;
  // The day filters become instants in the viewer's zone before the read: the
  // port takes a window, not a pair of civil days (auditWindow).
  const range = await auditWindow(ctx, source, filters);
  const [events, members] = await Promise.all([
    source.audit.events(ctx, { ...range, offset }),
    source.org.members(ctx),
  ]);
  return (
    <AuditView
      org={ctx.orgSlug}
      orgRole={ctx.orgRole}
      query={query}
      read={events}
      actors={
        members.ok
          ? members.value.members.map((member) => ({
              id: member.id,
              name: member.name ?? member.email,
            }))
          : []
      }
    />
  );
}

function AuditView({
  org,
  orgRole,
  query,
  read,
  actors,
}: {
  org: string;
  orgRole: OrgRole;
  query: AuditQuery;
  read: Read<AuditPage>;
  actors: readonly AuditActor[];
}) {
  const t = useTranslations("audit");
  if (!read.ok) return <Failure org={org} orgRole={orgRole} read={read} />;
  const page = read.value;
  return (
    <div className="flex flex-col gap-4">
      <FilterBar org={org} query={query} actors={actors} />
      <section
        aria-labelledby="audit-events"
        className={`${panel} flex flex-col`}
      >
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 id="audit-events" className="text-sm font-semibold">
            {t("events.title")}
          </h2>
          <ExportLinks org={org} query={query} />
        </header>
        {page.events.length === 0 ? (
          <Empty org={org} filtered={hasAuditFilters(query)} />
        ) : (
          <EventsTable events={page.events} actors={actors} />
        )}
        <Pager org={org} query={query} page={page} />
      </section>
    </div>
  );
}

/** The skeleton the page shows while the record is being read: one panel, seven rows. */
export function AuditSkeleton() {
  const t = useTranslations("audit");
  return (
    <section
      aria-busy="true"
      aria-label={t("loading")}
      data-state="loading"
      className={`${panel} flex flex-col gap-3 p-4`}
    >
      {[0, 1, 2, 3, 4, 5, 6].map((row) => (
        <span
          key={row}
          className="h-5 w-full animate-pulse rounded bg-muted motion-reduce:animate-none"
        />
      ))}
    </section>
  );
}

const field = "flex min-w-40 flex-col gap-1 text-sm";
const label = "text-xs font-medium text-muted-foreground";
const control =
  "min-h-10 rounded-md border border-input-border bg-input-bg px-2 py-1.5 text-sm text-input-fg focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-input-ring";

function FilterBar({
  org,
  query,
  actors,
}: {
  org: string;
  query: AuditQuery;
  actors: readonly AuditActor[];
}) {
  const t = useTranslations("audit");
  return (
    <SafeForm
      action={routes.audit(org)}
      method="get"
      aria-label={t("filters.label")}
      data-testid="audit-filters"
      className="flex flex-wrap items-end gap-3"
    >
      <span className={field}>
        <label className={label} htmlFor="audit-event-type">
          {t("filters.eventType")}
        </label>
        <select
          id="audit-event-type"
          name="eventType"
          defaultValue={query.eventType ?? ""}
          className={control}
        >
          <option value="">{t("filters.anyEventType")}</option>
          {AUDIT_EVENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </span>
      <span className={field}>
        <label className={label} htmlFor="audit-outcome">
          {t("filters.outcome")}
        </label>
        <select
          id="audit-outcome"
          name="outcome"
          defaultValue={query.outcome ?? ""}
          className={control}
        >
          <option value="">{t("filters.anyOutcome")}</option>
          {AUDIT_OUTCOMES.map((outcome) => (
            <option key={outcome} value={outcome}>
              {t(`outcomes.${outcome}`)}
            </option>
          ))}
        </select>
      </span>
      <span className={field}>
        <label className={label} htmlFor="audit-actor">
          {t("filters.actor")}
        </label>
        <select
          id="audit-actor"
          name="actor"
          defaultValue={query.actor ?? ""}
          className={control}
        >
          <option value="">{t("filters.anyActor")}</option>
          {actors.map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.name}
            </option>
          ))}
        </select>
      </span>
      <span className={field}>
        <label className={label} htmlFor="audit-capability">
          {t("filters.capability")}
        </label>
        <input
          id="audit-capability"
          name="capability"
          defaultValue={query.capability ?? ""}
          className={control}
        />
      </span>
      <span className={field}>
        <label className={label} htmlFor="audit-from">
          {t("filters.from")}
        </label>
        <input
          id="audit-from"
          name="from"
          type="date"
          defaultValue={query.from ?? ""}
          className={control}
        />
      </span>
      <span className={field}>
        <label className={label} htmlFor="audit-to">
          {t("filters.to")}
        </label>
        <input
          id="audit-to"
          name="to"
          type="date"
          defaultValue={query.to ?? ""}
          className={control}
        />
      </span>
      <button type="submit" className={buttonSecondary}>
        {t("filters.apply")}
      </button>
      <SafeLink to={routes.audit(org)} className={linkText}>
        {t("filters.clear")}
      </SafeLink>
    </SafeForm>
  );
}

// Both links are `prefetch={false}`: the href is a route handler that runs
// `export_audit_events`, and Next prefetches a Link that enters the viewport,
// so the default would walk up to 50,000 rows twice and record two exports
// nobody asked for, every time the page is opened.
function ExportLinks({ org, query }: { org: string; query: AuditQuery }) {
  const t = useTranslations("audit");
  return (
    <span className="flex flex-wrap items-center gap-2">
      <SafeLink
        to={routes.auditExport(org, auditQueryParams(query, { format: "csv" }))}
        prefetch={false}
        data-export="csv"
        className={buttonSecondary}
      >
        {t("export.csv")}
      </SafeLink>
      <SafeLink
        to={routes.auditExport(org, {
          ...auditQueryParams(query, { format: "ndjson" }),
        })}
        prefetch={false}
        data-export="ndjson"
        className={buttonSecondary}
      >
        {t("export.ndjson")}
      </SafeLink>
    </span>
  );
}

function EventsTable({
  events,
  actors,
}: {
  events: readonly AuditEvent[];
  actors: readonly AuditActor[];
}) {
  const t = useTranslations("audit");
  const names = new Map(actors.map((actor) => [actor.id, actor.name]));
  return (
    <Table
      label={t("events.title")}
      columns={[
        { label: t("events.when") },
        { label: t("events.event") },
        { label: t("events.actor") },
        { label: t("events.what") },
        { label: t("events.result") },
        { label: t("events.more") },
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
            {event.actor === null ? (
              <NotRecordedValue />
            ) : (
              (names.get(event.actor) ?? (
                <span className={mono}>{event.actor}</span>
              ))
            )}
          </td>
          <td className={`${cell} ${mono}`}>
            {event.capability ?? <NotRecordedValue />}
          </td>
          <td className={cell}>
            <Outcome outcome={event.outcome} />
          </td>
          <td className={cell}>
            <Details event={event} />
          </td>
        </tr>
      ))}
    </Table>
  );
}

function When({ iso }: { iso: string }) {
  const format = useFormatter();
  return (
    <time dateTime={iso} className="whitespace-nowrap">
      {format.dateTime(new Date(iso), {
        dateStyle: "medium",
        timeStyle: "medium",
      })}
    </time>
  );
}

function NotRecordedValue() {
  const t = useTranslations("audit");
  return (
    <span data-recorded="false" className="text-muted-foreground">
      {t("events.notRecorded")}
    </span>
  );
}

/** The result as a dot and a word, so it survives greyscale. */
function Outcome({ outcome }: { outcome: AuditEvent["outcome"] }) {
  const t = useTranslations("audit");
  if (outcome === null) return <NotRecordedValue />;
  return (
    <span
      data-outcome={outcome}
      className="inline-flex items-center gap-1.5 whitespace-nowrap"
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${
          outcome === "deny" || outcome === "error"
            ? "bg-destructive"
            : "bg-success"
        }`}
      />
      {t(`outcomes.${outcome}`)}
    </span>
  );
}

function Details({ event }: { event: AuditEvent }) {
  const t = useTranslations("audit");
  return (
    <details>
      <summary className="cursor-pointer text-sm text-muted-foreground">
        {t("events.more")}
      </summary>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pt-2 text-xs">
        <dt className={label}>{t("events.workspace")}</dt>
        <dd className={mono}>{event.workspace ?? <NotRecordedValue />}</dd>
        <dt className={label}>{t("events.ip")}</dt>
        <dd className={mono}>{event.ip ?? <NotRecordedValue />}</dd>
        <dt className={label}>{t("events.request")}</dt>
        <dd className={mono}>{event.request ?? <NotRecordedValue />}</dd>
        <dt className={label}>{t("events.userAgent")}</dt>
        <dd className="break-all">{event.userAgent ?? <NotRecordedValue />}</dd>
        <dt className={label}>{t("events.detail")}</dt>
        <dd className="min-w-0">
          {event.detail == null ? (
            <NotRecordedValue />
          ) : (
            <pre className="max-w-prose whitespace-pre-wrap break-all font-mono">
              {JSON.stringify(event.detail, null, 2)}
            </pre>
          )}
        </dd>
      </dl>
    </details>
  );
}

function Pager({
  org,
  query,
  page,
}: {
  org: string;
  query: AuditQuery;
  page: AuditPage;
}) {
  const t = useTranslations("audit");
  const newer = page.offset - page.limit;
  return (
    <nav
      aria-label={t("pager.label")}
      className="flex flex-wrap items-center gap-4 border-t border-border px-4 py-3 text-sm"
    >
      {newer >= 0 ? (
        <SafeLink
          to={routes.audit(
            org,
            auditQueryParams(query, { offset: Math.max(newer, 0) }),
          )}
          data-page="newer"
          className={linkText}
        >
          {t("pager.newer")}
        </SafeLink>
      ) : null}
      {page.hasMore ? (
        <SafeLink
          to={routes.audit(
            org,
            auditQueryParams(query, { offset: page.offset + page.limit }),
          )}
          data-page="older"
          className={linkText}
        >
          {t("pager.older")}
        </SafeLink>
      ) : (
        <span className="text-muted-foreground">{t("pager.end")}</span>
      )}
    </nav>
  );
}

function Empty({ org, filtered }: { org: string; filtered: boolean }) {
  const t = useTranslations("audit");
  return (
    <div
      data-state={filtered ? "filtered-empty" : "empty"}
      className="flex flex-col items-start gap-2 px-4 py-8"
    >
      <h3 className="text-base font-semibold">
        {filtered ? t("filteredEmpty.title") : t("empty.title")}
      </h3>
      <p className="max-w-prose text-sm text-muted-foreground">
        {filtered ? t("filteredEmpty.body") : t("empty.body")}
      </p>
      {filtered ? (
        <SafeLink to={routes.audit(org)} className={linkText}>
          {t("filters.clear")}
        </SafeLink>
      ) : (
        <SafeLink to={routes.people(org)} className={linkText}>
          {t("empty.action")}
        </SafeLink>
      )}
    </div>
  );
}

function Failure({
  org,
  orgRole,
  read,
}: {
  org: string;
  orgRole: OrgRole;
  read: Extract<Read<never>, { ok: false }>;
}) {
  const t = useTranslations("audit");
  switch (read.reason) {
    case "denied":
      return (
        <OutcomePanel
          tone="deny"
          testId="audit-denied"
          title={t("denied.title")}
        >
          {t("denied.body", {
            role: t(`roles.${orgRole}`),
            permission: read.permission,
          })}
        </OutcomePanel>
      );
    case "pending_approval":
      return (
        <OutcomePanel
          tone="neutral"
          testId="audit-pending"
          title={t("pending.title")}
        >
          {t("pending.body", { id: read.accessRequestId })}
        </OutcomePanel>
      );
    case "error":
      return (
        <OutcomePanel
          tone="neutral"
          testId="audit-error"
          title={t("error.title")}
          actions={
            <SafeLink to={routes.audit(org)} className={linkText}>
              {t("error.retry")}
            </SafeLink>
          }
        >
          <span className="flex flex-col gap-1">
            <span>{t("error.body")}</span>
            <span className={mono}>
              {t("error.code", {
                status: String(read.status),
                code: read.code,
              })}
            </span>
          </span>
        </OutcomePanel>
      );
  }
}
