// The Audit page's body (rev1 audit.md; #3097; ARCHITECTURE.md §1.2): six tabs
// under the header, Events on the page's own route and the other five on
// `/{org}/audit/<tab>`, each tab a URL segment so it survives a reload.
//
// One read decides the state on every tab: the Range window of
// query_audit_log (up to the contract's 200 rows), which the Events tiles and
// the Events tab count count. A refused read renders the denied state and a
// failed one the error state, never an empty record; an empty window is the
// empty state only when the record holds no event at all, which one more read
// of a single row decides. On Events a second read fetches the page of the
// table at the Rows size, narrowed by the Result filter. Actor names come from
// the members read the Organization page already makes.
//
// Retention reads the organization's evidence retention (get_evidence_retention)
// for Body retention and the policy dialog; Exports reads back the export
// Build bundle queued, by the id its URL carries (get_export_status). A denied
// read names the signed-in person from the session, as the design's "Signed
// in as" does.
//
// Incidents are not read. list_incidents answers one workspace, and this page
// has an organization viewer: reading every workspace would need a workspace
// viewer per workspace, which the app mints only for a workspace the person
// belongs to, so the count would be partial while reading as the
// organization's (#3874 records this and asks for an organization read).
//
// Every read here is a noBillingGate kernel read through the audit and org
// ports, gated in its handler (org Owner or Admin, INV-29).
import "server-only";
import { useLocale, useTranslations } from "next-intl";
import {
  AUDIT_TILE_LIMIT,
  type AuditBundle,
  type AuditPage,
  type AuditQuery,
  type AuditRetention,
} from "@/data/contracts/audit";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import { getAuthUser } from "@/server/session";
import type { OrgCtx } from "@/server/viewer";
import { firstParam, routes, type SafePath } from "@/shared/safe-path";
import { panel, statStrip, statTile } from "@/ui/control-styles";
import { RouteTabs } from "@/ui/route-tabs";
import { formatCount } from "@/ui/money-format";
import {
  type AuditActor,
  type AuditWindowRows,
  EventsPanel,
  EventTiles,
} from "./events";
import {
  auditQueryParams,
  auditWindow,
  hasAuditFilters,
  parseAuditQuery,
} from "./filters";
import {
  ExportsTab,
  IncidentsTab,
  KeysTab,
  ReceiptsTab,
  RetentionTab,
} from "./sections";
import { AuditEmpty, AuditFailure } from "./states";
import { AUDIT_TABS, type AuditTab } from "./tabs";

type Params = Readonly<Record<string, string | string[] | undefined>>;

type Failure = Exclude<Read<unknown>, { ok: true }>;

type Loaded =
  | {
      kind: "failed";
      read: Failure;
      fleet: SafePath | null;
      /** The signed-in person, named in the denied state. */
      viewer: string;
    }
  | { kind: "empty" }
  | {
      kind: "loaded";
      window: AuditWindowRows;
      page: AuditPage | null;
      actors: readonly AuditActor[];
      /** Read on Retention only. */
      retention: Read<AuditRetention> | null;
      /** The export the Exports URL names, and its read. */
      bundle: { id: string; read: Read<AuditBundle> } | null;
    };

/** An export id is a uuid; anything else in `?export=` is not read. */
const EXPORT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every read the page makes, and the instant they were made at. The clock is
 * read here, once, rather than in a component body: the window ends now, and
 * the error state names when the read failed.
 */
async function readAudit(
  ctx: OrgCtx,
  source: DataSource,
  tab: AuditTab,
  query: AuditQuery,
  exportId: string | null,
): Promise<{ loaded: Loaded; now: number }> {
  const now = Date.now();
  const { offset, rows, outcome, ...filters } = query;
  const range = await auditWindow(
    ctx,
    source,
    { ...filters, outcome: null },
    now,
  );
  const [windowRead, pageRead, members, retention, bundle] = await Promise.all([
    source.audit.events(ctx, {
      ...range,
      offset: 0,
      limit: AUDIT_TILE_LIMIT,
    }),
    tab === "events"
      ? source.audit.events(ctx, { ...range, outcome, offset, limit: rows })
      : Promise.resolve(null),
    source.org.members(ctx),
    tab === "retention" ? source.audit.retention(ctx) : Promise.resolve(null),
    tab === "exports" && exportId !== null
      ? source.audit.bundle(ctx, exportId)
      : Promise.resolve(null),
  ]);
  // The window read decides the state on every tab; on Events the page read
  // can fail on its own, and then it does.
  const failed = async (read: Failure) => ({
    loaded: {
      kind: "failed" as const,
      read,
      fleet: read.reason === "denied" ? await fleetOf(ctx, source) : null,
      viewer: read.reason === "denied" ? await viewerName() : "",
    },
    now,
  });
  if (!windowRead.ok) return failed(windowRead);
  if (pageRead !== null && !pageRead.ok) return failed(pageRead);
  if (
    windowRead.value.events.length === 0 &&
    !hasAuditFilters(query) &&
    (await recordIsEmpty(ctx, source))
  ) {
    return { loaded: { kind: "empty" }, now };
  }
  return {
    loaded: {
      kind: "loaded",
      window: {
        events: windowRead.value.events,
        complete: !windowRead.value.hasMore,
      },
      page: pageRead === null ? null : pageRead.value,
      actors: members.ok
        ? members.value.members.map((member) => ({
            id: member.id,
            name: member.name ?? member.email,
          }))
        : [],
      retention,
      bundle:
        exportId === null || bundle === null
          ? null
          : { id: exportId, read: bundle },
    },
    now,
  };
}

/** The signed-in person as the denied state names them: their name, or their email when they set none. */
async function viewerName(): Promise<string> {
  const user = await getAuthUser();
  // requireViewer admitted this request, so its session is present.
  if (user === null) throw new Error("audit_without_session");
  return user.name || user.email;
}

/** Whether the organization's record holds no event at all, in any window. */
async function recordIsEmpty(
  ctx: OrgCtx,
  source: DataSource,
): Promise<boolean> {
  const any = await source.audit.events(ctx, {
    eventType: null,
    outcome: null,
    actor: null,
    capability: null,
    since: null,
    until: null,
    offset: 0,
    limit: 1,
  });
  return any.ok && any.value.events.length === 0;
}

/** Fleet of the first workspace the viewer can open, where Back to Fleet goes. */
async function fleetOf(
  ctx: OrgCtx,
  source: DataSource,
): Promise<SafePath | null> {
  const read = await source.org.workspaces(ctx);
  const first = read.ok
    ? read.value.workspaces.find((ws) => ws.archivedAt === null)
    : undefined;
  return first === undefined ? null : routes.fleet(ctx.orgSlug, first.slug);
}

export async function Audit({
  ctx,
  source,
  tab,
  searchParams,
}: {
  ctx: OrgCtx;
  source: DataSource;
  tab: AuditTab;
  searchParams: Params;
}) {
  const query = parseAuditQuery(searchParams);
  const raw = firstParam(searchParams.export);
  const exportId =
    tab === "exports" && raw !== undefined && EXPORT_ID.test(raw)
      ? raw.toLowerCase()
      : null;
  const { loaded, now } = await readAudit(ctx, source, tab, query, exportId);
  return (
    <AuditBody
      ctx={ctx}
      tab={tab}
      query={query}
      exportId={exportId}
      loaded={loaded}
      now={now}
    />
  );
}

function tabPath(org: string, tab: AuditTab): SafePath {
  return tab === "events" ? routes.audit(org) : routes.auditTab(org, tab);
}

/** This same page with the query it was opened with, for Try again. */
function retryPath(
  org: string,
  tab: AuditTab,
  query: AuditQuery,
  exportId: string | null,
): SafePath {
  if (tab === "events") return routes.audit(org, auditQueryParams(query));
  return routes.auditTab(
    org,
    tab,
    exportId === null ? {} : { export: exportId },
  );
}

function AuditBody({
  ctx,
  tab,
  query,
  exportId,
  loaded,
  now,
}: {
  ctx: OrgCtx;
  tab: AuditTab;
  query: AuditQuery;
  exportId: string | null;
  loaded: Loaded;
  now: number;
}) {
  const t = useTranslations("audit.tabs");
  const tiles = useTranslations("audit.tiles");
  const locale = useLocale();
  const org = ctx.orgSlug;
  if (loaded.kind === "failed") {
    return (
      <AuditFailure
        read={loaded.read}
        org={org}
        orgName={ctx.orgName}
        orgRole={ctx.orgRole}
        viewer={loaded.viewer}
        retry={retryPath(org, tab, query, exportId)}
        fleet={loaded.fleet}
        organization={routes.people(org)}
        at={traceTime(now)}
      />
    );
  }
  if (loaded.kind === "empty") return <AuditEmpty org={org} />;
  const events = loaded.window.complete
    ? formatCount(loaded.window.events.length, locale)
    : tiles("atLeast", {
        count: formatCount(loaded.window.events.length, locale),
      });
  return (
    <div className="flex flex-col gap-3.5">
      <RouteTabs
        label={t("label")}
        tabs={AUDIT_TABS.map((each) => ({
          to: tabPath(org, each),
          label: t(each),
          current: each === tab,
          ...(each === "events" ? { count: events } : {}),
        }))}
      />
      {tab === "events" && loaded.page !== null ? (
        <>
          <EventTiles query={query} window={loaded.window} />
          <EventsPanel
            org={org}
            query={query}
            page={loaded.page}
            window={loaded.window}
            actors={loaded.actors}
          />
        </>
      ) : null}
      {tab === "incidents" ? <IncidentsTab /> : null}
      {tab === "receipts" ? <ReceiptsTab /> : null}
      {tab === "exports" ? (
        <ExportsTab org={org} bundle={loaded.bundle} />
      ) : null}
      {tab === "keys" ? <KeysTab /> : null}
      {tab === "retention" && loaded.retention !== null ? (
        <RetentionTab retention={loaded.retention} />
      ) : null}
    </div>
  );
}

/**
 * The skeleton the page shows while the record is read (audit.md, loading):
 * four tile blocks and a panel of seven rows, with no figure in any of them.
 * It marks itself `data-audit-state` like the other states, so the header
 * steps out of view and the skeleton is shown alone, as the design draws it.
 */

/**
 * The error line's time as the design prints it: `2026-09-11 09:16:04Z`.
 *
 * @internal Exported for its unit test.
 */
export function traceTime(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19).replace("T", " ")}Z`;
}

export function AuditSkeleton() {
  const t = useTranslations("audit");
  const block = "animate-pulse rounded bg-muted motion-reduce:animate-none";
  return (
    <section
      aria-busy="true"
      aria-label={t("loading")}
      data-state="loading"
      data-audit-state="loading"
      className="flex flex-col gap-3.5"
    >
      <div className={statStrip}>
        {[0, 1, 2, 3].map((tile) => (
          <span key={tile} className={`${statTile} h-[86px]`}>
            <span className={`${block} h-3 w-24`} />
          </span>
        ))}
      </div>
      <div className={`${panel} flex flex-col gap-2 p-4`}>
        <span className={`${block} mb-2 h-4 w-44`} />
        {[0, 1, 2, 3, 4, 5, 6].map((row) => (
          <span key={row} className={`${block} h-5 w-full`} />
        ))}
      </div>
    </section>
  );
}
