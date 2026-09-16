// Tools (#2958; ARCHITECTURE.md §1.2, mockup `mockups/pages/tools.md`): the
// registry of tool versions with their safety classification, the credential
// grants the broker minted, and the kill switches reaching this workspace.
//
// Three tabs, because three of the mockup's six are backed today. Mandates
// ledger, Policy and Auto-approvals are their own lanes and add their names to
// TOOLS_TABS and their case to TabBody when they land; nothing else here
// moves.
//
// Each tab makes only the reads it shows, except the switch count on the tab
// strip: a count in navigation appears where something waits on a person, and
// a switch that is denying is exactly that. The kernel seam serves one read
// per request, so the switches tab does not pay for that count twice.
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { panel } from "@/ui/control-styles";
import { useTranslations } from "next-intl";
import { Connections } from "./connections";
import { Registry } from "./registry";
import { Switches, switchesOn } from "./switches";
import { ToolsTabs } from "./tabs";
import { parseToolsView, type ToolsAt, type ToolsView } from "./view";

/**
 * An org Owner or Admin: exactly what `set_tool_classification` and
 * `set_kill_switch` declare (both grant no workspace role at all), so hiding
 * their controls from anyone else hides nothing the kernel would have allowed.
 */
function canAdministerOrg(ctx: WsCtx): boolean {
  return ctx.orgRole === "owner" || ctx.orgRole === "admin";
}

/**
 * The same org roles, for the import control — knowingly narrower than the
 * capability.
 *
 * `import_tools` allows an org Owner or Admin *or a workspace Owner*
 * (packages/oxagen/src/contracts/tool.import.ts defaultRoles), and the
 * organization role is the only role `WsCtx` carries, so this gate cannot
 * represent that third case: a workspace Owner whose org role is `member` is
 * authorized by the handler and offered no control here. The gate that matches
 * the capability wants the viewer's workspace role on `WsFields`
 * (apps/app/src/server/viewer.ts), which `workspace.workspace_users.role`
 * stores and `systemLookups.workspaceMember` does not select today. Widening
 * the viewer seam is not this lane's change, so the narrower gate stands and
 * is named rather than left to look exact.
 */
function canImportUnderOrgRole(ctx: WsCtx): boolean {
  return canAdministerOrg(ctx);
}

async function TabBody({
  ctx,
  source,
  view,
  at,
}: {
  ctx: WsCtx;
  source: DataSource;
  view: ToolsView;
  at: ToolsAt;
}) {
  switch (view.tab) {
    case "registry": {
      const read = await source.tools.versions(ctx, {
        category: view.category,
        cursor: view.cursor,
      });
      return (
        <Registry
          at={at}
          orgRole={ctx.orgRole}
          names={view.names}
          category={view.category}
          cursor={view.cursor}
          canImport={canImportUnderOrgRole(ctx)}
          canClassify={canAdministerOrg(ctx)}
          read={read}
        />
      );
    }
    case "connections": {
      const read = await source.tools.grants(ctx, { cursor: view.cursor });
      return (
        <Connections
          at={at}
          orgRole={ctx.orgRole}
          cursor={view.cursor}
          read={read}
        />
      );
    }
    case "switches": {
      const read = await source.tools.killSwitches(ctx);
      return (
        <Switches
          at={at}
          orgRole={ctx.orgRole}
          canFlip={canAdministerOrg(ctx)}
          selfWorkspaceId={ctx.workspaceId}
          read={read}
        />
      );
    }
  }
}

export async function Tools({
  ctx,
  source,
  searchParams,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The query the URL carried: `tab`, `category`, `names`, `cursor`. */
  searchParams: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const view = parseToolsView(searchParams);
  const at: ToolsAt = { org: ctx.orgSlug, ws: ctx.wsSlug };
  const board = await source.tools.killSwitches(ctx);
  return (
    <div className="flex flex-col gap-6">
      <ToolsTabs
        at={at}
        current={view.tab}
        switchesOn={board.ok ? switchesOn(board.value.switches) : null}
        switchesOnIsFloor={board.ok && board.value.truncated}
      />
      {await TabBody({ ctx, source, view, at })}
    </div>
  );
}

/** The skeleton the route shows while the tab's read runs; the shell stays. */
export function ToolsLoading() {
  const t = useTranslations("tools");
  return (
    <section
      data-state="loading"
      aria-busy="true"
      aria-label={t("loading")}
      className={`${panel} flex flex-col gap-3 p-4`}
    >
      <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
      <div className="h-10 animate-pulse rounded-md bg-muted" />
      <div className="h-10 animate-pulse rounded-md bg-muted" />
      <div className="h-10 animate-pulse rounded-md bg-muted" />
    </section>
  );
}
