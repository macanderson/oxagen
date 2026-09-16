// Organization › API keys (ARCHITECTURE.md §1.2): the keys of one workspace,
// from list_api_keys, under the tabs that link People and API keys. A key names
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
import { useTranslations } from "next-intl";
import type { ApiKey, ManagedWorkspace } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { OrgCtx, OrgRole } from "@/server/viewer";
import { WsCtx } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import { OutcomePanel } from "@/ui/form-feedback";
import { RouteTabs } from "@/ui/route-tabs";
import { Table } from "@/ui/table";
import { CreateKeyDialog } from "./create-key-dialog";
import { KeyRow } from "./key-row";
import { emptyLine } from "./parts";

/**
 * The workspace this page reads in: the one the URL names when the viewer may
 * enter it, else the first unarchived one the viewer may enter, else the first
 * of any, else none. The page resolves
 * the answer through `requireViewer`, which is where membership is checked
 * (INV-15), so an unknown or refused slug falls back rather than 404ing a page
 * the viewer is entitled to.
 */
export function chooseWorkspace(
  workspaces: Read<ManagedWorkspace[]>,
  wanted: string | undefined,
): string | null {
  if (!workspaces.ok) return null;
  const named = workspaces.value.find((ws) => ws.slug === wanted);
  if (named) return named.slug;
  // Nothing named: land on a workspace still in use. An archived one is
  // reachable — its keys still authenticate and have to be revocable — but it
  // is not where a page opens.
  const live = workspaces.value.find((ws) => !ws.archived);
  return live?.slug ?? workspaces.value[0]?.slug ?? null;
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
}: {
  /** A `WsCtx` once a workspace is in scope; an `OrgCtx` when there is none. */
  ctx: OrgCtx;
  source: DataSource;
  workspaces: Read<ManagedWorkspace[]>;
}) {
  const { current, keys, now } = await readKeys(ctx, source);
  return (
    <ApiKeysView
      orgSlug={ctx.orgSlug}
      orgRole={ctx.orgRole}
      workspaces={workspaces}
      current={current}
      read={keys}
      now={now}
    />
  );
}

function ApiKeysView({
  orgSlug,
  orgRole,
  workspaces,
  current,
  read,
  now,
}: {
  orgSlug: string;
  orgRole: OrgRole;
  workspaces: Read<ManagedWorkspace[]>;
  /** The workspace in scope, or null when the viewer may enter none. */
  current: string | null;
  /** Null when there is no workspace to read in. */
  read: Read<ApiKey[]> | null;
  /** The instant the page was rendered, against which an expiry is judged. */
  now: number;
}) {
  const t = useTranslations("organization");
  return (
    <div className="flex flex-col gap-6">
      <RouteTabs
        label={t("tabs.label")}
        tabs={[
          {
            to: routes.people(orgSlug),
            label: t("tabs.people"),
            current: false,
          },
          {
            to: routes.apiKeys(orgSlug),
            label: t("tabs.apiKeys"),
            current: true,
          },
        ]}
      />
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
            workspaces={workspaces.value}
            current={current}
          />
          {workspaces.value.find((ws) => ws.slug === current)?.archived ===
          true ? (
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
              now={now}
              here={routes.apiKeys(orgSlug, { workspace: current })}
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

/** The workspaces the viewer may enter, as links on this one route (ADR-073). */
function WorkspacePicker({
  orgSlug,
  workspaces,
  current,
}: {
  orgSlug: string;
  workspaces: readonly ManagedWorkspace[];
  current: string;
}) {
  const t = useTranslations("organization.apiKeys");
  return (
    <RouteTabs
      label={t("workspace.label")}
      tabs={workspaces.map((ws) => ({
        to: routes.apiKeys(orgSlug, { workspace: ws.slug }),
        // An archived workspace is named as archived. It is here because its
        // keys still authenticate and a key nobody can reach is a key nobody
        // can revoke; the label says it is not a workspace in use.
        label: ws.archived
          ? t("workspace.archived", { name: ws.name })
          : ws.name,
        current: ws.slug === current,
      }))}
    />
  );
}

function Keys({
  keys,
  org,
  ws,
  now,
  here,
}: {
  keys: readonly ApiKey[];
  org: string;
  /** The workspace the keys belong to, and the one a new key is minted in. */
  ws: string;
  now: number;
  /** This page, reloaded after a key was minted, rotated or revoked. */
  here: SafePath;
}) {
  const t = useTranslations("organization.apiKeys");
  // The ids the server just listed: the client island drops a shown secret the
  // moment its key appears here, so no reload can leave one on screen.
  const listedIds = keys.map((key) => key.id);
  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-prose text-sm text-muted-foreground">{t("lead")}</p>
      <div className="flex justify-end">
        <CreateKeyDialog org={org} ws={ws} listedIds={listedIds} after={here} />
      </div>
      {keys.length === 0 ? (
        <p className={emptyLine}>{t("empty")}</p>
      ) : (
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
          {keys.map((key) => (
            <KeyRow
              key={key.id}
              apiKey={key}
              org={org}
              ws={ws}
              now={now}
              listedIds={listedIds}
              here={here}
            />
          ))}
        </Table>
      )}
    </div>
  );
}
