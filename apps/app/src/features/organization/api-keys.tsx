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
// on the keys that still work, hides the revoked ones behind one link, and
// shows `API_KEYS_PAGE` rows at a time. Both are query values on this one route
// (`api-keys-view.ts`), so a filtered page survives a reload and a shared link.
import { useLocale, useTranslations } from "next-intl";
import type { ApiKey, Workspace, WorkspaceList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { OrgCtx, OrgRole } from "@/server/viewer";
import { WsCtx } from "@/server/viewer";
import { linkText } from "@/ui/control-styles";
import { OutcomePanel } from "@/ui/form-feedback";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { RouteTabs } from "@/ui/route-tabs";
import { Table } from "@/ui/table";
import {
  API_KEYS_PAGE,
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
import { emptyLine } from "./parts";
import { OrganizationTabs } from "./tabs";

/**
 * The workspaces of the organization this viewer may actually enter: the ones
 * they hold a membership in, archived included. `list_workspaces` answers the
 * organization's whole set, with `role` null for a workspace the viewer is not
 * a member of, and `requireViewer(org, slug)` answers `not_found` for exactly
 * those — so a picker offering one would offer a page that cannot open.
 *
 * Archived workspaces stay: `archive_workspace` records `archived_at` and
 * nothing else, `resolveApiKey` never consults it, so a key in an archived
 * workspace keeps authenticating. A key nobody can reach is a key nobody can
 * revoke.
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
    <div className="flex flex-col gap-6">
      {/* The shared strip, not a local copy of it: a hand-rolled two-entry
          list here left the Roles tab unreachable from this page the moment
          Roles was added (#3110). One component owns which tabs exist. */}
      <OrganizationTabs org={orgSlug} current="apiKeys" />
      {!workspaces.ok ? (
        <Refused read={workspaces} orgRole={orgRole} />
      ) : current === null || read === null ? (
        <OutcomePanel
          tone="neutral"
          testId="api-keys-no-workspace"
          title={t("apiKeys.noWorkspace.title")}
        >
          {t("apiKeys.noWorkspace.body")}
        </OutcomePanel>
      ) : (
        <>
          <WorkspacePicker
            orgSlug={orgSlug}
            workspaces={mine}
            current={current}
            show={view.show}
          />
          {chosen !== undefined && chosen.archivedAt !== null ? (
            <OutcomePanel
              tone="neutral"
              testId="api-keys-archived-workspace"
              title={t("apiKeys.workspace.label")}
            >
              {t("apiKeys.workspace.archivedNote")}
            </OutcomePanel>
          ) : null}
          {read.ok ? (
            <Keys
              keys={read.value}
              org={orgSlug}
              ws={current}
              archived={chosen?.archivedAt != null}
              now={now}
              show={view.show}
              offset={view.offset}
            />
          ) : (
            <Refused read={read} orgRole={orgRole} />
          )}
        </>
      )}
    </div>
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
  offset,
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
  /** Whether the revoked keys are on the roster; they are not, by default. */
  show: ApiKeysShow;
  /** The page the URL asked for, before it is clamped to one that exists. */
  offset: number;
}) {
  const t = useTranslations("organization.apiKeys");
  const kept = filterKeys(keys, show);
  const page = pageOfKeys(kept, offset);
  // How many rows the default filter is holding back. It names the link that
  // brings them, so "show the revoked ones" is never a guess about whether
  // there are any.
  const revoked = keys.length - filterKeys(keys, "active").length;
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
  const here = apiKeysLink(org, { workspace: ws, show, offset: page.offset });
  const afterMint = apiKeysLink(org, { workspace: ws, show });
  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-prose text-sm text-muted-foreground">{t("lead")}</p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RevokedFilter org={org} ws={ws} show={show} revoked={revoked} />
        {archived ? null : (
          <CreateKeyDialog
            org={org}
            ws={ws}
            listedIds={listedIds}
            after={afterMint}
          />
        )}
      </div>
      {page.total === 0 ? (
        <p
          className={emptyLine}
          data-state={
            show === "all" || revoked === 0 ? "empty" : "empty-active"
          }
        >
          {show === "all" || revoked === 0
            ? t("empty")
            : t("emptyActive", { revoked })}
        </p>
      ) : (
        <>
          <Table
            label={t("tableLabel")}
            columns={[
              { label: t("columns.name") },
              { label: t("columns.prefix") },
              { label: t("columns.created") },
              { label: t("columns.lastUsed") },
              { label: t("columns.expires") },
              { label: t("columns.status") },
              { label: t("columns.actions") },
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
          <Pager org={org} ws={ws} show={show} page={page} />
        </>
      )}
    </div>
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
  revoked,
}: {
  org: string;
  ws: string;
  show: ApiKeysShow;
  /** How many revoked keys the roster holds, for the label. */
  revoked: number;
}) {
  const t = useTranslations("organization.apiKeys.filter");
  return (
    <nav aria-label={t("label")} className="flex gap-1">
      {API_KEYS_SHOW.map((option) => (
        <SafeLink
          key={option}
          to={apiKeysLink(org, { workspace: ws, show: option })}
          data-show={option}
          aria-current={show === option ? "page" : undefined}
          className="inline-flex min-h-9 items-center rounded-md border border-transparent px-3 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[current=page]:border-border aria-[current=page]:text-foreground"
        >
          {option === "all" && revoked > 0
            ? t("allWithCount", { revoked })
            : t(option)}
        </SafeLink>
      ))}
    </nav>
  );
}

/** Previous and next pages of the filtered roster; nothing when one page holds it all. */
function Pager({
  org,
  ws,
  show,
  page,
}: {
  org: string;
  ws: string;
  show: ApiKeysShow;
  page: ApiKeysPage;
}) {
  const t = useTranslations("organization.apiKeys.pager");
  const locale = useLocale();
  const previous = page.offset - API_KEYS_PAGE;
  const next = page.offset + page.rows.length;
  if (page.offset === 0 && next >= page.total) return null;
  return (
    <nav
      aria-label={t("label")}
      className="flex flex-wrap items-center gap-4 text-sm"
    >
      <span className="text-muted-foreground">
        {t("range", {
          from: formatCount(page.offset + 1, locale),
          to: formatCount(next, locale),
          total: formatCount(page.total, locale),
        })}
      </span>
      {page.offset > 0 ? (
        <SafeLink
          to={apiKeysLink(org, {
            workspace: ws,
            show,
            offset: Math.max(previous, 0),
          })}
          data-page="previous"
          className={linkText}
        >
          {t("previous")}
        </SafeLink>
      ) : null}
      {next < page.total ? (
        <SafeLink
          to={apiKeysLink(org, { workspace: ws, show, offset: next })}
          data-page="next"
          className={linkText}
        >
          {t("next")}
        </SafeLink>
      ) : null}
    </nav>
  );
}
