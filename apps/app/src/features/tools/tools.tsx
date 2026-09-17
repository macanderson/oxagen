// Tools (#2958, #2957; ARCHITECTURE.md §1.2, mockup `mockups/pages/tools.md`):
// the registry of tool versions with their safety classification, the
// credential grants the broker minted, the kill switches reaching this
// workspace, and the ledger of every mandate the workspace has granted.
//
// Four tabs, because four of the mockup's six are backed today. #2958 shipped
// the shell and the first three and left the slot this comment described;
// #2957's ledger fills it, adding its name to TOOLS_TABS and its case below
// and moving nothing else. Policy and Auto-approvals are still their own lanes
// and arrive the same way.
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
import { MandatesLedger } from "./mandates-ledger";
import { Registry } from "./registry";
import { Switches, switchesOn } from "./switches";
import { ToolsTabs } from "./tabs";
import { parseToolsView, type ToolsAt, type ToolsView } from "./view";

/**
 * An org Owner or Admin: exactly what `set_tool_classification` and
 * `set_kill_switch` declare (both grant no workspace role at all), so hiding
 * their controls from anyone else hides nothing the kernel would have allowed.
 * Each of those handlers asserts the same pair itself, on every org tier, and
 * INV-29 pins the assertion — see the note on `canImportTools`.
 */
function canAdministerOrg(ctx: WsCtx): boolean {
  return ctx.orgRole === "owner" || ctx.orgRole === "admin";
}

/**
 * `import_tools` allows an org Owner or Admin *or this workspace's Owner*
 * (packages/oxagen/src/contracts/tool.import.ts `defaultRoles`, which
 * packages/handlers/src/tool.import.ts asserts verbatim), so the gate reads
 * both of the roles the viewer carries. Until `WsFields` carried `wsRole`
 * (#3145) the third case could not be written at all, and a workspace Owner
 * holding org `member` was offered no control the kernel would have accepted
 * (#3143).
 *
 * Neither role here is the gate. The gate is `assertOrgRole` in
 * `packages/handlers/src/tool.import.ts`, which runs on every org tier — the
 * kernel's IAM check fast-paths a non-enterprise org to an unconditional allow
 * for a human principal (`packages/iam/src/check-iam.ts`), so the handler's own
 * assertion is what refuses, and INV-29 (`packages/handlers/src/
 * role-check.test.ts`) pins that it stays there. This gate decides which
 * control a person is shown, never whether the write lands.
 *
 * The two halves of it are not equally trustworthy. `orgRole` and `wsRole` come
 * from the membership tables (`org_users.role`,
 * `workspace.workspace_users.role`); `assertOrgRole` reads
 * `iam.principal_role_assignments` for a principal of kind `human`. The org
 * side agrees by construction — every path that writes `org_users.role` writes
 * the matching IAM assignment in the same transaction (`org.create.ts`,
 * `org.member_invite.accept.ts`, `org.member_role.change.ts`). The workspace
 * side does not: `workspace.workspace_users` is written only by
 * `workspace-bootstrap.ts`, which records the creator as `owner` and assigns no
 * IAM role, and nothing in the tree gives a human principal a workspace-scoped
 * one. So `import_tools`' workspace clause matches nobody today, and this gate
 * offers a workspace Owner holding org `member` a control the kernel will
 * refuse with `org_role_required`.
 *
 * The gate still reads the contract rather than that gap, because the contract
 * is the statement of authority and a gate hard-coded to the current absence of
 * an assignment path would be right by accident and have to be rediscovered
 * when the path lands. What the gap costs is one refused click, named where the
 * person acted: `action-failure.ts` gives the import path its own sentence,
 * which says the workspace Owner is admitted too rather than contradicting the
 * control they were just offered.
 */
function canImportTools(ctx: WsCtx): boolean {
  return canAdministerOrg(ctx) || ctx.wsRole === "owner";
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
          canImport={canImportTools(ctx)}
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
    case "mandates": {
      // Every mandate in the workspace, so no agent narrows the read; the
      // ledger is what the accountable office reads across agents. `orgRole`
      // goes in because an unaccountable reader is answered a narrowed list
      // and the section must say so rather than present it as the whole.
      const read = await source.mandates.list(ctx, { agentId: null });
      return <MandatesLedger read={read} orgRole={ctx.orgRole} />;
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
