// Tools (#2958, #2957; ARCHITECTURE.md §1.2, mockup `mockups/pages/tools.md`):
// the registry of tool versions with their safety classification, the
// credential grants the broker minted, the kill switches reaching this
// workspace, the ledger of every mandate the workspace has granted, and the
// auto-approval rules that let a call skip a person (ADR-070).
//
// Five tabs, because five of the mockup's six are backed today. #2958 shipped
// the shell and the first three and left the slot this comment described;
// #2957's ledger filled it, and Auto-approvals arrived the same way: its name
// in TOOLS_TABS, its case below, and nothing else moved. Policy is still its
// own lane.
//
// Each tab makes only the reads it shows, except the switch count on the tab
// strip: a count in navigation appears where something waits on a person, and
// a switch that is denying is exactly that. The kernel seam serves one read
// per request, so the switches tab does not pay for that count twice.
import type { AgentPage } from "@/data/contracts/agents";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { panel } from "@/ui/control-styles";
import { useTranslations } from "next-intl";
import { AutoApprovals } from "./auto-approvals";
import { Connections } from "./connections";
import { type LedgerGrant, MandatesLedger } from "./mandates-ledger";
import { Registry } from "./registry";
import { Servers } from "./servers";
import { Switches, switchesOn } from "./switches";
import { ToolsTabs } from "./tabs";
import { parseToolsView, type ToolsAt, type ToolsView } from "./view";

/**
 * An org Owner or Admin: exactly what `set_tool_classification`,
 * `set_kill_switch`, `set_approval_rules`, `set_approval_rule_enabled` and
 * `delete_approval_rule` declare (none grants a workspace role), so hiding
 * their controls from anyone else hides nothing the kernel would have allowed.
 * Each of those handlers asserts the same pair itself, on every org tier, and
 * INV-29 pins the assertion — see the note on `canImportTools`.
 */
function canAdministerOrg(ctx: WsCtx): boolean {
  return ctx.orgRole === "owner" || ctx.orgRole === "admin";
}

/**
 * The same org roles, for the import control — and the contradiction behind
 * that, because a gate that merely looked exact here would hide it.
 *
 * `import_tools` declares `workspace: { Owner: "allow" }` and its handler
 * asserts `workspace: ["Owner"]` (packages/handlers/src/tool.import.ts:141),
 * so on paper this workspace's Owner may import whatever their org role. No
 * person can satisfy that clause. `assertOrgRole` resolves a workspace role
 * from `iam.principal_role_assignments`, and nothing in the tree writes one
 * for a human: `workspace-bootstrap.ts` records the creator in
 * `workspace.workspace_users` and assigns no IAM role,
 * `iam-provision.ts` creates the workspace-scoped roles and hands them to
 * nobody, and the one insert setting a non-null `workspace_id`
 * (`agent.role.assign.ts`) refuses human system roles. The org half has no
 * such gap — every path writing `org_users.role` writes the matching IAM
 * assignment in the same transaction — which is why `ctx.orgRole` is a
 * faithful proxy for what the handler will find and `ctx.wsRole` is not.
 *
 * So this reads only the role that is enforceable. Widening it to
 * `ctx.wsRole === "owner"` would promise authority nothing can grant, and
 * would promise it to a viewer who cannot reach the control anyway:
 * `list_tool_versions` asserts the same empty workspace clause, so an org
 * `member` is denied the registry read and `Registry` answers `ToolsReadFailure`
 * before `ImportControls` is reached.
 *
 * The gate is not the decision. Whether workspace membership should confer
 * IAM authority at all — for this capability and the 215 others declaring a
 * `workspace:` clause — is #3198, and it wants an ADR. When that lands, this
 * reads `ctx.wsRole` again and `tools.test.tsx` derives from the full
 * `defaultRoles` rather than the org clause alone.
 */
function canImportTools(ctx: WsCtx): boolean {
  return canAdministerOrg(ctx);
}

/**
 * An org Owner, Admin, Billing or Compliance member: every role a consequence
 * can name. `grant_mandate` asserts, in its handler and on every org tier, an
 * org role the workspace names for every tag on the mandate
 * (`assertConsequenceRole`, INV-29), and both the defaults and the workspace's
 * `consequence_roles` overrides draw only from those four
 * (`consequenceRolesSchema`). So hiding the control from anyone else hides
 * nothing the kernel would have allowed.
 *
 * It is wider than any one grant. A Billing member may grant `moves_money` and
 * is refused `destroys_data`, and which tags a person will pick is not known
 * until they pick them. The handler makes that call and the dialog names its
 * refusal. The org role is the enforceable one here for the reason
 * `canImportTools` gives.
 */
function canGrantMandates(ctx: WsCtx): boolean {
  return (
    ctx.orgRole === "owner" ||
    ctx.orgRole === "admin" ||
    ctx.orgRole === "billing" ||
    ctx.orgRole === "compliance"
  );
}

/**
 * What the grant dialog's picker offers, from one page of `list_agents`. A
 * retired identity is left out and remembered, so its requested drafts are
 * offered no Grant: retirement suspends the principal, and a mandate granted
 * after it can never be drawn. A read with a next page is marked partial, and
 * the picker says so, rather than presenting the page as every agent.
 */
function grantableAgents(read: Read<AgentPage>): LedgerGrant {
  if (!read.ok) return { agents: { ok: false }, retired: new Set() };
  const live = read.value.agents.filter((agent) => agent.status !== "retired");
  return {
    agents: {
      ok: true,
      agents: live.map((agent) => ({
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
      })),
      partial: read.value.nextCursor !== null,
    },
    retired: new Set(
      read.value.agents
        .filter((agent) => agent.status === "retired")
        .map((agent) => agent.id),
    ),
  };
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
      // The server roster comes with the registry: the import control picks
      // from it, and the servers section under the table is where a row in it
      // is registered.
      const [read, servers] = await Promise.all([
        source.tools.versions(ctx, {
          category: view.category,
          cursor: view.cursor,
        }),
        source.tools.mcpServers(ctx),
      ]);
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
          servers={servers}
        />
      );
    }
    case "connections": {
      // Two reads: the workspace's connections, and the grants log of the
      // uses they were put to. Neither narrows the other, and a refusal of
      // one leaves the other readable.
      const [read, connections, servers] = await Promise.all([
        source.tools.grants(ctx, { cursor: view.cursor }),
        source.tools.connections(ctx, { status: null, connectorId: null }),
        source.tools.mcpServers(ctx),
      ]);
      return (
        <div className="flex flex-col gap-6">
          <Servers
            at={at}
            orgRole={ctx.orgRole}
            canRegister={canAdministerOrg(ctx)}
            read={servers}
          />
          <Connections
            at={at}
            orgRole={ctx.orgRole}
            cursor={view.cursor}
            connections={connections}
            read={read}
          />
        </div>
      );
    }
    case "switches": {
      // The operator level's picker needs the org roster (#3147); a failed
      // members read leaves the picker with nothing to choose, which the
      // control states rather than blocking the rest of the board.
      const [read, members] = await Promise.all([
        source.tools.killSwitches(ctx),
        source.org.members(ctx),
      ]);
      return (
        <Switches
          at={at}
          orgRole={ctx.orgRole}
          canFlip={canAdministerOrg(ctx)}
          selfWorkspaceId={ctx.workspaceId}
          members={members.ok ? members.value.members : []}
          read={read}
        />
      );
    }
    case "mandates": {
      // Every mandate in the workspace, so no agent narrows the read; the
      // ledger is what the accountable office reads across agents. `orgRole`
      // goes in because an unaccountable reader is answered a narrowed list
      // and the section must say so rather than present it as the whole.
      //
      // A reader who may grant also gets the agents read, which the picker
      // needs; anyone else is not charged for it.
      const [read, agents] = await Promise.all([
        source.mandates.list(ctx, { agentId: null }),
        canGrantMandates(ctx)
          ? source.agents.list(ctx, { cursor: null })
          : Promise.resolve(null),
      ]);
      return (
        <MandatesLedger
          read={read}
          orgRole={ctx.orgRole}
          at={at}
          grant={agents === null ? null : grantableAgents(agents)}
        />
      );
    }
    case "autoapprovals": {
      // `list_approval_rules` admits an org Owner, Admin or Compliance, so a
      // Compliance reader sees the rules and the counters with no control on
      // them. The three writes admit an org Owner or Admin only, which is
      // `canAdministerOrg` exactly; each handler asserts the same pair.
      const read = await source.tools.approvalRules(ctx);
      return (
        <AutoApprovals
          at={at}
          orgRole={ctx.orgRole}
          canWrite={canAdministerOrg(ctx)}
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
