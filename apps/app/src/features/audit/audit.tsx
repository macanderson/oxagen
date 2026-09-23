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
// Every read here is a noBillingGate kernel read through the audit and org
// ports, gated in its handler (org Owner or Admin, INV-29).
import "server-only";
import { useTranslations } from "next-intl";
import {
  AUDIT_TILE_LIMIT,
  type AuditPage,
  type AuditQuery,
} from "@/data/contracts/audit";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { OrgCtx } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import { panel, statStrip, statTile } from "@/ui/control-styles";
import { RouteTabs } from "@/ui/route-tabs";
import { useFormatter } from "@/ui/formatter";
import {
  type AuditActor,
  type AuditWindowRows,
  EventsPanel,
  EventTiles,
} from "./events";
import { auditWindow, hasAuditFilters, parseAuditQuery } from "./filters";
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
  | { kind: "failed"; read: Failure; fleet: SafePath | null }
  | { kind: "empty" }
  | {
      kind: "loaded";
      window: AuditWindowRows;
      page: AuditPage | null;
      actors: readonly AuditActor[];
    };

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
): Promise<{ loaded: Loaded; now: number }> {
  const now = Date.now();
  const { offset, rows, outcome, ...filters } = query;
  const range = await auditWindow(
    ctx,
    source,
    { ...filters, outcome: null },
    now,
  );
  const [windowRead, pageRead, members] = await Promise.all([
    source.audit.events(ctx, { ...range, offset: 0, limit: AUDIT_TILE_LIMIT }),
    tab === "events"
      ? source.audit.events(ctx, { ...range, outcome, offset, limit: rows })
      : Promise.resolve(null),
    source.org.members(ctx),
  ]);
  // The window read decides the state on every tab; on Events the page read
  // can fail on its own, and then it does.
  const failed = async (read: Failure) => ({
    loaded: {
      kind: "failed" as const,
      read,
      fleet: read.reason === "denied" ? await fleetOf(ctx, source) : null,
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
      page: pageRead !== null && pageRead.ok ? pageRead.value : null,
      actors: members.ok
        ? members.value.members.map((member) => ({
            id: member.id,
            name: member.name ?? member.email,
          }))
        : [],
    },
    now,
  };
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
  const { loaded, now } = await readAudit(ctx, source, tab, query);
  return (
    <AuditBody ctx={ctx} tab={tab} query={query} loaded={loaded} now={now} />
  );
}

function tabPath(org: string, tab: AuditTab): SafePath {
  return tab === "events" ? routes.audit(org) : routes.auditTab(org, tab);
}

function AuditBody({
  ctx,
  tab,
  query,
  loaded,
  now,
}: {
  ctx: OrgCtx;
  tab: AuditTab;
  query: AuditQuery;
  loaded: Loaded;
  now: number;
}) {
  const t = useTranslations("audit.tabs");
  const tiles = useTranslations("audit.tiles");
  const format = useFormatter();
  const org = ctx.orgSlug;
  if (loaded.kind === "failed") {
    return (
      <AuditFailure
        read={loaded.read}
        orgName={ctx.orgName}
        orgRole={ctx.orgRole}
        retry={tabPath(org, tab)}
        fleet={loaded.fleet}
        organization={routes.people(org)}
        at={new Date(now).toISOString()}
      />
    );
  }
  if (loaded.kind === "empty") return <AuditEmpty org={org} />;
  const events = loaded.window.complete
    ? format.number(loaded.window.events.length)
    : tiles("atLeast", { count: format.number(loaded.window.events.length) });
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
      {tab === "exports" ? <ExportsTab /> : null}
      {tab === "keys" ? <KeysTab /> : null}
      {tab === "retention" ? <RetentionTab /> : null}
    </div>
  );
}

/**
 * The skeleton the page shows while the record is read (audit.md, loading):
 * four tile blocks and a panel of seven rows, with no figure in any of them.
 */
export function AuditSkeleton() {
  const t = useTranslations("audit");
  const block = "animate-pulse rounded bg-muted motion-reduce:animate-none";
  return (
    <section
      aria-busy="true"
      aria-label={t("loading")}
      data-state="loading"
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
