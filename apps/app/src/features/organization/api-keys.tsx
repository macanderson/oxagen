// Organization › API keys (ARCHITECTURE.md §1.2): the keys of one workspace,
// from list_api_keys, under the shared Organization tabs. A key names
// a workspace (ADR-073) — `auth.api_keys` is policy class `standard`, so the
// org-only sentinel lists no key that exists and mints one into a workspace
// that does not — and the page therefore names one too: a `?workspace=` query
// value on this one route, picked from the workspaces the viewer may enter.
//
// The contract returns no secret and no hash, so the table prints the prefix
// that identifies a key on sight and the instants of its life, and nothing that
// could be exchanged for access. A refused or failed read replaces the table;
// the tabs stay. The three writes on a key — create, rotate, revoke (WL-43) —
// are open to whoever can read this table: all four contracts are gated on the
// same org roles in the same place (INV-29). The secret a minting write returns
// is shown once by the client island, never by anything this section reads.
//
// A row judges its own state and its own controls against one clock that keeps
// running (`key-row.tsx`), so the status word and the controls beside it cannot
// disagree as a page ages past an expiry. `rotate_api_key` refuses an expired,
// revoked or service-owned key regardless — that refusal is the guarantee and
// the row is the courtesy.
//
// `list_api_keys` answers the workspace's whole roster, revoked rows included,
// with no filter and no page of its own. The cut is made here: the page opens
// on the active keys, hides the revoked and expired ones behind one link, and
// shows ten rows at a time, or the 5, 25, 50 or All the Rows select
// picks, under a numbered pager. All three are query values on this one route
// (`api-keys-view.ts`), so a filtered page survives a reload and a shared link.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { ApiKey, Workspace, WorkspaceList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { OrgCtx, OrgRole } from "@/server/viewer";
import { WsCtx } from "@/server/viewer";
import { panel, panelBody, panelHeader, panelTitle } from "@/ui/control-styles";
import { Badge } from "@/ui/badge";
import { OutcomePanel } from "@/ui/form-feedback";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { RouteTabs } from "@/ui/route-tabs";
import { Table } from "@/ui/table";
import { ApiKeysRows } from "./api-keys-rows";
import {
  API_KEYS_ROWS,
  API_KEYS_SHOW,
  type ApiKeysPage,
  type ApiKeysShow,
  type ApiKeysView,
  apiKeysLink,
  filterKeys,
  pageOfKeys,
} from "./api-keys-view";
import { CreateKeyDialog } from "./create-key-dialog";
import { KeyRow } from "./key-row";
import { emptyLine, note } from "./parts";

/**
 * The workspaces of the organization this viewer may actually enter: the ones
 * they hold a membership in, archived included. `list_workspaces` answers the
 * organization's whole set, with `role` null for a workspace the viewer is not
 * a member of, and `requireViewer(org, slug)` answers `not_found` for exactly
 * those — so a picker offering one would offer a page that cannot open.
 *
 * Archived workspaces stay. Their keys no longer authenticate — `resolveApiKey`
 * refuses a key whose workspace is archived (ADR-104) — but they are not
 * revoked, and restoring the workspace restores them. An operator who wants one
 * gone for good still has to reach it, and this picker is how.
 */
function enterable(workspaces: WorkspaceList): readonly Workspace[] {
  return workspaces.workspaces.filter((ws) => ws.role !== null);
}

/**
 * The workspace this page reads in: the one the URL names when the viewer may
 * enter it, else the first unarchived one the viewer may enter, else the first
 * of any, else none. The page resolves the answer through `requireViewer`,
 * which is where membership is checked (INV-15), so an unknown or refused slug
 * falls back rather than 404ing a page the viewer is entitled to.
 */
export function chooseWorkspace(
  workspaces: Read<WorkspaceList>,
  wanted: string | undefined,
): string | null {
  if (!workspaces.ok) return null;
  const mine = enterable(workspaces.value);
  const named = mine.find((ws) => ws.slug === wanted);
  if (named) return named.slug;
  // Nothing named: land on a workspace still in use. An archived one is
  // reachable — its keys still authenticate and have to be revocable — but it
  // is not where a page opens.
  const live = mine.find((ws) => ws.archivedAt === null);
  return live?.slug ?? mine[0]?.slug ?? null;
}

/**
 * The keys of the workspace in scope, and the instant they were read — the
 * clock an expiry is judged against starts when the read returned, so the
 * table is pure of it (the Fleet reads do the same).
 */
async function readKeys(ctx: OrgCtx, source: DataSource) {
  const inWorkspace = WsCtx.is(ctx) ? ctx : null;
  const keys =
    inWorkspace === null ? null : await source.org.apiKeys(inWorkspace);
  return { current: inWorkspace?.wsSlug ?? null, keys, now: Date.now() };
}

export async function ApiKeys({
  ctx,
  source,
  workspaces,
  view,
}: {
  /** A `WsCtx` once a workspace is in scope; an `OrgCtx` when there is none. */
  ctx: OrgCtx;
  source: DataSource;
  workspaces: Read<WorkspaceList>;
  /** The filter and the page the URL asked for (`api-keys-view.ts`). */
  view: ApiKeysView;
}) {
  const { current, keys, now } = await readKeys(ctx, source);
  return (
    <ApiKeysSection
      orgSlug={ctx.orgSlug}
      orgRole={ctx.orgRole}
      workspaces={workspaces}
      current={current}
      read={keys}
      now={now}
      view={view}
    />
  );
}

function ApiKeysSection({
  orgSlug,
  orgRole,
  workspaces,
  current,
  read,
  now,
  view,
}: {
  orgSlug: string;
  orgRole: OrgRole;
  workspaces: Read<WorkspaceList>;
  /** The workspace in scope, or null when the viewer may enter none. */
  current: string | null;
  /** Null when there is no workspace to read in. */
  read: Read<ApiKey[]> | null;
  /** The instant the page was rendered, against which an expiry is judged. */
  now: number;
  view: ApiKeysView;
}) {
  const t = useTranslations("organization");
  // Computed once: the picker lists these and the archived note asks which of
  // them is in scope.
  const mine = workspaces.ok ? enterable(workspaces.value) : [];
  const chosen = mine.find((ws) => ws.slug === current);
  return (
    <div className="flex flex-col gap-3.5">
      {!workspaces.ok ? (
        <KeysPanel>
          <Refused read={workspaces} orgRole={orgRole} />
        </KeysPanel>
      ) : current === null || read === null ? (
        <KeysPanel>
          <OutcomePanel
            tone="neutral"
            testId="api-keys-no-workspace"
            title={t("apiKeys.noWorkspace.title")}
          >
            {t("apiKeys.noWorkspace.body")}
          </OutcomePanel>
        </KeysPanel>
      ) : read.ok ? (
        <Keys
          keys={read.value}
          org={orgSlug}
          ws={current}
          archived={chosen?.archivedAt != null}
          now={now}
          show={view.show}
          rows={view.rows}
          offset={view.offset}
          picker={
            <WorkspacePicker
              orgSlug={orgSlug}
              workspaces={mine}
              current={current}
              show={view.show}
            />
          }
          archivedNote={
            chosen !== undefined && chosen.archivedAt !== null ? (
              <p
                data-testid="api-keys-archived-workspace"
                className={`${panelBody} ${note}`}
              >
                {t("apiKeys.workspace.archivedNote")}
              </p>
            ) : null
          }
        />
      ) : (
        <KeysPanel>
          <WorkspacePicker
            orgSlug={orgSlug}
            workspaces={mine}
            current={current}
            show={view.show}
          />
          <Refused read={read} orgRole={orgRole} />
        </KeysPanel>
      )}
      <Surfaces org={orgSlug} />
    </div>
  );
}

/**
 * The API keys panel (mockup `pOrganization` keys tab): the title, the caption
 * that each key is a service principal with its own grants, the store badge
 * and Create key, over whatever the read left to show.
 */
function KeysPanel({
  create,
  children,
}: {
  create?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations("organization.apiKeys");
  return (
    <section aria-labelledby="org-api-keys" className={panel}>
      <div className={panelHeader}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="org-api-keys" className={panelTitle}>
            {t("title")}
          </h2>
          <span className="text-xs text-dim">{t("caption")}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="quiet" dot={false} data-store="api-keys">
            {t("badge")}
          </Badge>
          {create}
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * Surfaces this reaches: the API, MCP, the CLI and these screens run on one
 * agent tool contract, so what a key may do here it may do everywhere. The
 * four command lines are commands the `oxagen` CLI ships
 * (apps/cli/src/program.ts), with this organization's slug filled in.
 */
function Surfaces({ org }: { org: string }) {
  const t = useTranslations("organization.apiKeys.surfaces");
  const lines = [
    `$ oxagen login --org ${org}`,
    "$ oxagen budget show",
    "$ oxagen run export <run-id>",
    "$ oxagen agent status <agent>",
  ];
  return (
    <section aria-labelledby="org-api-surfaces" className={panel}>
      <div className={panelHeader}>
        <h2 id="org-api-surfaces" className={panelTitle}>
          {t("title")}
        </h2>
        <Badge tone="quiet" dot={false}>
          {t("badge")}
        </Badge>
      </div>
      <div className={`${panelBody} flex flex-col gap-2.5`}>
        <p className="text-[12.5px] text-muted-foreground">{t("body")}</p>
        <pre
          data-testid="api-keys-cli"
          className="overflow-x-auto rounded-lg border border-border bg-hl px-3.5 py-3 font-mono text-[11.5px] leading-relaxed"
        >
          {lines.join("\n")}
        </pre>
      </div>
    </section>
  );
}

/** The one rendering of a read that did not list, for either of the page's reads. */
function Refused({
  read,
  orgRole,
}: {
  read: Exclude<Read<unknown>, { ok: true }>;
  orgRole: OrgRole;
}) {
  const t = useTranslations("organization");
  if (read.reason === "denied") {
    return (
      <OutcomePanel
        tone="deny"
        testId="api-keys-denied"
        title={t("apiKeys.denied.title")}
      >
        {t("apiKeys.denied.body", {
          role: t(`roles.${orgRole}`),
          permission: read.permission,
        })}
      </OutcomePanel>
    );
  }
  if (read.reason === "pending_approval") {
    return (
      <OutcomePanel
        tone="neutral"
        testId="api-keys-pending"
        title={t("apiKeys.pending.title")}
      >
        {t("apiKeys.pending.body", { id: read.accessRequestId })}
      </OutcomePanel>
    );
  }
  return (
    <OutcomePanel
      tone="neutral"
      testId="api-keys-error"
      title={t("apiKeys.error.title")}
    >
      {t("apiKeys.error.body", { status: read.status, code: read.code })}
    </OutcomePanel>
  );
}

/**
 * The workspaces the viewer may enter, as links on this one route (ADR-073).
 * A link carries the filter across — a person who asked to see revoked keys
 * asked about keys, not about this workspace — and drops the page, because the
 * next workspace has a roster of its own and page four of this one says
 * nothing about it.
 */
function WorkspacePicker({
  orgSlug,
  workspaces,
  current,
  show,
}: {
  orgSlug: string;
  workspaces: readonly Workspace[];
  current: string;
  show: ApiKeysShow;
}) {
  const t = useTranslations("organization.apiKeys");
  return (
    <RouteTabs
      label={t("workspace.label")}
      tabs={workspaces.map((ws) => ({
        to: apiKeysLink(orgSlug, { workspace: ws.slug, show }),
        // An archived workspace is named as archived. It is here because its
        // keys still authenticate and a key nobody can reach is a key nobody
        // can revoke; the label says it is not a workspace in use.
        label:
          ws.archivedAt === null
            ? ws.name
            : t("workspace.archived", { name: ws.name }),
        current: ws.slug === current,
      }))}
    />
  );
}

function Keys({
  keys,
  org,
  ws,
  archived,
  now,
  show,
  rows,
  offset,
  picker,
  archivedNote,
}: {
  /** The workspace's whole roster, newest first, revoked rows included. */
  keys: readonly ApiKey[];
  org: string;
  /** The workspace the keys belong to, and the one a new key is minted in. */
  ws: string;
  /**
   * Whether that workspace is archived. No key is minted into one: its
   * existing keys keep authenticating and are listed so they can be revoked,
   * which is the opposite of issuing another. `create_api_key` refuses it
   * (`conflict` / `workspace_archived`) and that refusal is the guarantee;
   * withholding the control is the courtesy.
   */
  archived: boolean;
  now: number;
  /** Whether the revoked and expired keys are on the roster; they are not, by default. */
  show: ApiKeysShow;
  /** Rows per page; 0 is All. */
  rows: number;
  /** The page the URL asked for, before it is clamped to one that exists. */
  offset: number;
  /** The workspace picker: a key names a workspace (ADR-073). */
  picker: ReactNode;
  /** The archived workspace's note, when the workspace in scope is archived. */
  archivedNote: ReactNode;
}) {
  const t = useTranslations("organization.apiKeys");
  const kept = filterKeys(keys, show, now);
  const page = pageOfKeys(kept, offset, rows);
  // How many rows the default filter is holding back. It names the link that
  // brings them, so "show the revoked ones" is never a guess about whether
  // there are any.
  const ended = keys.length - filterKeys(keys, "active", now).length;
  // Every id the server just listed, not just this page's: the client island
  // drops a shown secret the moment its key appears here, and a key minted
  // while the roster was filtered or paged past the first is somewhere in this
  // read even when it is not on screen. Narrowing this to the visible rows
  // would leave that secret up with nothing left to clear it.
  const listedIds = keys.map((key) => key.id);
  // Where a write returns to. A mint puts a new key at the top of the roster,
  // so create and rotate land on the first page of the filter in view — the
  // one place the new key is certain to be. Revoke changes no order and holds
  // its place, so it returns to the page the person was reading; under the
  // default filter the row it ended leaves that page, which is the point.
  const here = apiKeysLink(org, {
    workspace: ws,
    show,
    rows,
    offset: page.offset,
  });
  const afterMint = apiKeysLink(org, { workspace: ws, show, rows });
  return (
    <KeysPanel
      create={
        archived ? null : (
          <CreateKeyDialog
            org={org}
            ws={ws}
            listedIds={listedIds}
            after={afterMint}
          />
        )
      }
    >
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5">
        {picker}
        <div className="flex flex-wrap items-center gap-2">
          <RevokedFilter
            org={org}
            ws={ws}
            show={show}
            rows={rows}
            ended={ended}
          />
          {/* A new page size starts again from the first page: page four of
              ten rows is not page four of fifty. */}
          <ApiKeysRows
            current={rows}
            options={API_KEYS_ROWS.map((n) => ({
              rows: n,
              to: apiKeysLink(org, { workspace: ws, show, rows: n }),
            }))}
          />
        </div>
      </div>
      {archivedNote}
      {page.total === 0 ? (
        <p
          className={`${emptyLine} ${panelBody}`}
          data-state={
            show === "all" || ended === 0 ? "empty" : "empty-filtered"
          }
        >
          {show === "all" || ended === 0
            ? t("empty")
            : t("emptyFiltered", { ended })}
        </p>
      ) : (
        <>
          <Table
            label={t("tableLabel")}
            columns={[
              { label: t("columns.name") },
              { label: t("columns.principal") },
              { label: t("columns.grants") },
              { label: t("columns.createdBy") },
              { label: t("columns.lastUsed") },
              { label: t("columns.actions30d"), numeric: true },
              { label: t("columns.expires") },
              { label: t("columns.actions"), hidden: true },
            ]}
          >
            {page.rows.map((key) => (
              <KeyRow
                key={key.id}
                apiKey={key}
                org={org}
                ws={ws}
                archived={archived}
                now={now}
                listedIds={listedIds}
                here={here}
                afterMint={afterMint}
              />
            ))}
          </Table>
          <div className="px-3 py-2.5">
            <Pager org={org} ws={ws} show={show} rows={rows} page={page} />
          </div>
        </>
      )}
      <div className={panelBody}>
        <p className={note}>{t("note")}</p>
      </div>
    </KeysPanel>
  );
}

/**
 * The one control that brings the revoked keys back, and sends them away
 * again. Two links rather than a checkbox: the filter is a query value, so it
 * has to be reachable without JavaScript and shareable once chosen, and a link
 * per state is the shape the workspace picker above it already uses. Switching
 * drops the offset — page four of the active keys is not page four of all of
 * them.
 */
function RevokedFilter({
  org,
  ws,
  show,
  rows,
  ended,
}: {
  org: string;
  ws: string;
  show: ApiKeysShow;
  /** The page size in force, which a filter change keeps. */
  rows: number;
  /** How many revoked or expired keys the roster holds, for the label. */
  ended: number;
}) {
  const t = useTranslations("organization.apiKeys.filter");
  return (
    <nav aria-label={t("label")} className="flex gap-1">
      {API_KEYS_SHOW.map((option) => (
        <SafeLink
          key={option}
          to={apiKeysLink(org, { workspace: ws, show: option, rows })}
          data-show={option}
          data-touch-target=""
          aria-current={show === option ? "page" : undefined}
          className="inline-flex min-h-9 max-md:min-h-11 items-center rounded-md border border-transparent px-3 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[current=page]:border-border aria-[current=page]:text-foreground"
        >
          {option === "all" && ended > 0
            ? t("allWithCount", { ended })
            : t(option)}
        </SafeLink>
      ))}
    </nav>
  );
}

/**
 * The filtered roster's range and pages (the design's "1–10 of 14 ‹ 1 2 ›"):
 * a link to each page, with ‹ and › for the previous and next. Every one is a
 * link on this route, so paging works without JavaScript and survives a
 * reload.
 */
function Pager({
  org,
  ws,
  show,
  rows,
  page,
}: {
  org: string;
  ws: string;
  show: ApiKeysShow;
  rows: number;
  page: ApiKeysPage;
}) {
  const t = useTranslations("organization.apiKeys.pager");
  const locale = useLocale();
  const next = page.offset + page.rows.length;
  const pages = Math.max(1, Math.ceil(page.total / page.size));
  const current = Math.floor(page.offset / page.size) + 1;
  const link = (n: number) =>
    apiKeysLink(org, {
      workspace: ws,
      show,
      rows,
      offset: (n - 1) * page.size,
    });
  const pagerLink =
    "inline-flex min-h-7 min-w-7 items-center justify-center rounded-[7px] border border-button-default-border bg-button-default-bg px-2 py-0.5 text-[12px] tabular-nums text-button-default-fg hover:bg-button-default-hover-bg aria-[current=page]:border-gold aria-[current=page]:text-accent-text max-md:min-h-11 max-md:min-w-11";
  return (
    <nav
      aria-label={t("label")}
      className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground"
    >
      <span className="font-mono tabular-nums text-dim">
        {t("range", {
          from: formatCount(page.offset + 1, locale),
          to: formatCount(next, locale),
          total: formatCount(page.total, locale),
        })}
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-1">
        {current > 1 ? (
          <SafeLink
            to={link(current - 1)}
            data-page="previous"
            aria-label={t("previous")}
            className={pagerLink}
          >
            ‹
          </SafeLink>
        ) : null}
        {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
          <SafeLink
            key={n}
            to={link(n)}
            data-page={n}
            aria-current={n === current ? "page" : undefined}
            className={pagerLink}
          >
            {formatCount(n, locale)}
          </SafeLink>
        ))}
        {current < pages ? (
          <SafeLink
            to={link(current + 1)}
            data-page="next"
            aria-label={t("next")}
            className={pagerLink}
          >
            ›
          </SafeLink>
        ) : null}
      </span>
    </nav>
  );
}
