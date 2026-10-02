// A Studio server's page (#4678), at `/tools/servers/<mcs_id>[/<tab>]` inside
// Tools: the server's name and off switch in the header, then four tabs.
// Tools lists what the server offers and what the workspace imported,
// Connection says where it runs and how it signs in, Test calls one tool,
// and Changes shows the draft that becomes a steering PR.
//
// The page reads the registry, the switch board and the org's members, as the
// Tools page does, plus the Studio record and, on Changes, the tool checks'
// findings. The record is the server's steering folder, read through
// get_studio_server by the folder the registry row names (record-read.ts). The
// findings come from list_studio_findings (#4742), and on Tools the page reads
// list_studio_tools' counts (#4682), both through studio-calls.ts. Each names
// the server by its folder, so neither is read for a server with no folder.
// The registry read follows
// the server's cursor to its last page, so a server with more versions than
// one page holds still shows every tool with its version and off switch. A
// failed registry read, on any page, replaces the whole body the way it does
// on Tools, and a server the workspace does not hold is its own state, so a
// stale link never draws an empty page.
//
// The off switches are the Tools page's own controls (switch-controls.tsx),
// drawn here on the server and handed to the tabs, so a flip here writes the
// same row the Switches tab lists.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  KillSwitch,
  McpServer,
  ToolVersion,
} from "@/data/contracts/tools";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";
import {
  FlipControls,
  SwitchActor,
  ToolsReadFailure,
} from "@/features/tools";
import { routes, type SafePath } from "@/shared/safe-path";
import type { WsCtx } from "@/server/viewer";
import { Badge } from "@/ui/badge";
import {
  buttonSecondary,
  kvList,
  kvTerm,
  kvValue,
  note,
  panel,
  statStrip,
  statTile,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { PageHeader } from "@/ui/page-header";
import { RouteTabPanel } from "@/ui/route-tabs";
import { StateWrap } from "@/ui/state-wrap";
import { ChangesTab } from "./changes-tab";
import { ConnectionTab } from "./connection-tab";
import { buildStudioView, type StudioServerView } from "./model";
import {
  STUDIO_PANEL,
  type StudioAt,
  type StudioRoute,
  studioHref,
} from "./route";
import { readStudioRecord } from "./record-read";
import type { RecordReader, StudioFinding } from "./seams";
import {
  type ListStudioFindings,
  listStudioFindings,
  listStudioTools,
  type StudioToolsList,
} from "./studio-calls";
import { StudioTabs } from "./studio-tabs";
import { ToolsTab } from "./tools-tab";
import { TryTab } from "./try-tab";

type Member = { id: string; name: string | null; email: string };
type DenyGeneration = { org: number; workspace: number };

/**
 * The most registry pages the page reads for one server: 1,000 versions at
 * list_tool_versions' default of 50 a page. Past it the page shows the
 * versions it read and the Tools count reads as a floor.
 */
const VERSION_PAGE_BOUND = 20;

/** Every registry version of one server, and whether the last page was read. */
type ServerVersions = { items: ToolVersion[]; complete: boolean };

/**
 * Walk the server-filtered registry cursor to its end, up to the bound. A
 * failed page fails the whole read with that page's own refusal, since a
 * view built from part of the registry would drop tools without saying so.
 */
async function serverVersions(
  ctx: WsCtx,
  source: DataSource,
  serverId: string,
): Promise<Read<ServerVersions>> {
  const items: ToolVersion[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < VERSION_PAGE_BOUND; page += 1) {
    const read = await source.tools.versions(ctx, {
      category: null,
      cursor,
      serverId,
    });
    if (!read.ok) return read;
    items.push(...read.value.items);
    cursor = read.value.nextCursor;
    if (cursor === null) return readOk({ items, complete: true });
  }
  return readOk({ items, complete: false });
}

/**
 * An org Owner or Admin: the roles `set_kill_switch` and the Studio writes
 * assert at org scope. It is the Tools page's rule (tools.tsx), which does not
 * read the workspace Owner role yet (#3198).
 */
function canAdministerOrg(ctx: WsCtx): boolean {
  return ctx.orgRole === "owner" || ctx.orgRole === "admin";
}

/** Who turned a switch off, why, and who turned it back on. */
function SwitchFacts({
  item,
  members,
}: {
  item: KillSwitch;
  members: readonly Member[];
}) {
  const t = useTranslations("mcpStudio.off");
  const unrecorded = t("unrecorded");
  return (
    <dl className={kvList} data-testid={`studio-switch-facts-${item.id}`}>
      <dt className={kvTerm}>{t("flippedBy")}</dt>
      <dd className={kvValue}>
        <SwitchActor
          userRef={item.flippedByRef}
          at={item.flippedAt}
          members={members}
          unrecorded={unrecorded}
        />
      </dd>
      {item.reason.length > 0 ? (
        <>
          <dt className={kvTerm}>{t("reason")}</dt>
          <dd className={kvValue}>{item.reason}</dd>
        </>
      ) : null}
      {item.clearedAt === null ? null : (
        <>
          <dt className={kvTerm}>{t("clearedBy")}</dt>
          <dd className={kvValue}>
            <SwitchActor
              userRef={item.clearedByRef}
              at={item.clearedAt}
              members={members}
              unrecorded={unrecorded}
            />
          </dd>
        </>
      )}
    </dl>
  );
}

/** A link to a server the workspace does not hold, or no longer holds. */
function StudioMissing({ at }: { at: StudioAt }) {
  const t = useTranslations("mcpStudio.missing");
  return (
    <StateWrap
      tone="neutral"
      testId="studio-missing"
      title={t("title")}
      actions={
        <SafeLink
          to={routes.tools(at.org, at.ws, { tab: "providers" })}
          className={buttonSecondary}
        >
          {t("back")}
        </SafeLink>
      }
    >
      {t("body")}
    </StateWrap>
  );
}

function StudioHeader({
  ctx,
  at,
  here,
  server,
  view,
  flips,
  denyGeneration,
  members,
}: {
  ctx: WsCtx;
  at: StudioAt;
  here: SafePath;
  server: McpServer;
  view: StudioServerView;
  flips: boolean;
  denyGeneration: DenyGeneration;
  members: readonly Member[];
}) {
  const t = useTranslations("mcpStudio");
  const own = view.killSwitch;
  return (
    <PageHeader
      title={server.name}
      eyebrow={t("eyebrow", { workspace: ctx.wsName })}
      description={t("lede")}
      figure={
        own?.on === true ? (
          <Badge tone="denied" data-testid="studio-server-off">
            {t("off.badge")}
          </Badge>
        ) : undefined
      }
      meta={own === null ? undefined : <SwitchFacts item={own} members={members} />}
      actions={
        flips ? (
          <FlipControls
            at={at}
            denyGeneration={denyGeneration}
            existing={own}
            fixed={
              own === null ? { kind: "tool_server", ref: server.id } : undefined
            }
            label={server.name}
            members={members}
            returnTo={here}
          />
        ) : undefined
      }
    />
  );
}

/** The board's state, when it keeps the page from saying every switch. */
function BoardNote({ state }: { state: "failed" | "truncated" | null }) {
  const t = useTranslations("mcpStudio");
  if (state === "failed") {
    return (
      <p className={note} data-testid="studio-board-failed">
        {t("boardFailed")}
      </p>
    );
  }
  if (state === "truncated") {
    return (
      <p className={note} data-testid="studio-board-truncated">
        {t("truncated")}
      </p>
    );
  }
  return null;
}

/**
 * The tool checks' findings on one server folder, or null when there are none
 * to show: the record names no folder, or the read was refused.
 */
async function findingsOf(
  at: StudioAt,
  list: ListStudioFindings,
  serverName: string | null,
): Promise<readonly StudioFinding[] | null> {
  if (serverName === null) return null;
  const answer = await list.call(at, { server: serverName });
  return answer.ok ? answer.findings : null;
}

/**
 * One server's tool counts from list_studio_tools, or null when there are
 * none to show: the record names no folder, or the read was refused.
 */
async function listedOf(
  at: StudioAt,
  list: typeof listStudioTools,
  serverName: string | null,
): Promise<StudioToolsList | null> {
  if (serverName === null) return null;
  const answer = await list.call(at, { server: serverName });
  return answer.ok ? answer : null;
}

export async function StudioServer({
  ctx,
  source,
  route,
  readRecord = readStudioRecord,
  findings = listStudioFindings,
  toolsList = listStudioTools,
}: {
  ctx: WsCtx;
  source: DataSource;
  route: StudioRoute;
  /** The Studio record's reader. A test passes a fake. */
  readRecord?: RecordReader;
  /** The tool checks' capability. A test passes a fake. */
  findings?: ListStudioFindings;
  /** The Tools tab's counts. A test passes a fake. */
  toolsList?: typeof listStudioTools;
}) {
  const at: StudioAt = { org: ctx.orgSlug, ws: ctx.wsSlug };
  const here = studioHref(at, route.serverId, route.tab);
  const canEdit = canAdministerOrg(ctx);
  // The record is read by the folder the registry row names, so it waits on
  // the server list alone. The other reads run beside it.
  const serverList = source.tools.mcpServers(ctx);
  const recordRead = serverList.then((read) => {
    const row = read.ok
      ? read.value.servers.find((s) => s.id === route.serverId)
      : undefined;
    return row === undefined ? null : readRecord(ctx, row);
  });
  const [servers, versions, board, members, record] = await Promise.all([
    serverList,
    serverVersions(ctx, source, route.serverId),
    source.tools.killSwitches(ctx),
    source.org.members(ctx),
    recordRead,
  ]);
  if (!servers.ok) {
    return (
      <ToolsReadFailure
        at={at}
        orgRole={ctx.orgRole}
        read={servers}
        retry={here}
      />
    );
  }
  if (!versions.ok) {
    return (
      <ToolsReadFailure
        at={at}
        orgRole={ctx.orgRole}
        read={versions}
        retry={here}
      />
    );
  }
  const server = servers.value.servers.find((s) => s.id === route.serverId);
  if (server === undefined) return <StudioMissing at={at} />;

  const view = buildStudioView({
    server,
    versions: versions.value.items,
    board: board.ok ? board.value : null,
    record,
  });
  // The checks name the server by its folder, which only the record gives.
  const checks =
    route.tab === "changes"
      ? await findingsOf(at, findings, view.serverName)
      : null;
  const listed =
    route.tab === "tools"
      ? await listedOf(at, toolsList, view.serverName)
      : null;
  const roster = members.ok ? members.value.members : [];
  const denyGeneration = board.ok
    ? board.value.denyGeneration
    : { org: 0, workspace: 0 };
  // A flip needs the board's deny generation, so a failed board read draws
  // no toggle rather than one that writes against a guessed generation.
  const flips = canEdit && board.ok;

  const off: Record<string, ReactNode> = {};
  const offFacts: Record<string, ReactNode> = {};
  for (const tool of view.tools) {
    if (flips && tool.versionId !== null) {
      off[tool.name] = (
        <FlipControls
          at={at}
          denyGeneration={denyGeneration}
          existing={tool.killSwitch}
          fixed={
            tool.killSwitch === null
              ? { kind: "tool_version", ref: tool.versionId }
              : undefined
          }
          label={tool.name}
          members={roster}
          returnTo={here}
        />
      );
    }
    if (tool.killSwitch !== null) {
      offFacts[tool.name] = (
        <SwitchFacts item={tool.killSwitch} members={roster} />
      );
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="studio-server">
      <StudioHeader
        ctx={ctx}
        at={at}
        here={here}
        server={server}
        view={view}
        flips={flips}
        denyGeneration={denyGeneration}
        members={roster}
      />
      <BoardNote
        state={
          !board.ok ? "failed" : board.value.truncated ? "truncated" : null
        }
      />
      <StudioTabs
        at={at}
        serverName={view.serverName}
        serverId={server.id}
        current={route.tab}
        tools={view.tools}
        complete={versions.value.complete}
      />
      <RouteTabPanel
        panel={STUDIO_PANEL}
        className="flex min-w-0 flex-col gap-4"
      >
        {route.tab === "tools" ? (
          <ToolsTab
            at={at}
            serverName={view.serverName}
            serverId={server.id}
            record={view.record}
            tools={view.tools}
            canEdit={canEdit}
            off={off}
            offFacts={offFacts}
            listed={listed}
          />
        ) : null}
        {route.tab === "connection" ? (
          <ConnectionTab
            at={at}
            server={server}
            record={view.record}
            environments={view.environments}
            agentEnvironment={view.agentEnvironment}
            canEdit={canEdit}
          />
        ) : null}
        {route.tab === "try" ? (
          <TryTab
            at={at}
            serverName={view.serverName}
            serverId={server.id}
            tools={view.tools}
            environments={view.environments}
            agentEnvironment={view.agentEnvironment}
            canEdit={canEdit}
          />
        ) : null}
        {route.tab === "changes" ? (
          <ChangesTab
            at={at}
            serverName={view.serverName}
            serverId={server.id}
            record={view.record}
            sourceType={view.record?.source.type ?? null}
            tools={view.tools}
            findings={checks}
            canEdit={canEdit}
          />
        ) : null}
      </RouteTabPanel>
    </div>
  );
}

/**
 * The skeleton the route shows while the reads run, the Tools page's own:
 * four tile blocks and a panel of seven rows.
 */
export function StudioLoading() {
  const t = useTranslations("mcpStudio");
  const block = "skeleton rounded-md";
  return (
    <div
      data-state="loading"
      aria-busy="true"
      role="status"
      aria-label={t("loading")}
      className="flex flex-col gap-4"
    >
      <div className={statStrip}>
        {[0, 1, 2, 3].map((index) => (
          <div key={index} data-skeleton="tile" className={`${statTile} h-16`}>
            <div className={`${block} h-3 w-1/2`} />
          </div>
        ))}
      </div>
      <div className={panel}>
        <div className="border-b border-border px-4 py-3">
          <div className={`${block} h-4 w-40`} />
        </div>
        <div className="flex flex-col gap-2 p-4">
          {[0, 1, 2, 3, 4, 5, 6].map((index) => (
            <div key={index} data-skeleton="row" className={`${block} h-9`} />
          ))}
        </div>
      </div>
    </div>
  );
}
