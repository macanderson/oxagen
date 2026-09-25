// Tools (mockup `tools.md`, route `tools[/<tab>]`): every tool version the
// registry holds, the providers they came from, the toolbelts that put a tool
// in front of an agent, the policy that decides a call, and the kill switches.
// The chain the page makes readable is Provider → Tool → Toolbelt → Agent.
//
// The page reads the registry's first page, the provider roster and the switch
// board before it draws anything, because all three feed the header and the
// tab strip. The registry read decides the page's state: a refusal or an
// outage of the tool read replaces the whole body (header and tabs included)
// and never the shell, and a workspace with no provider and no version is the
// empty state. The kernel seam serves one read per request, so a tab body that
// asks for the same record again pays nothing.
import { useTranslations } from "next-intl";
import type { AgentPage } from "@/data/contracts/agents";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { panel, statStrip, statTile } from "@/ui/control-styles";
import { PageHeader } from "@/ui/page-header";
import { FlipControls } from "./switch-controls";
import { ImportProvider } from "./import-provider";
import type { LedgerGrant } from "./mandates-ledger";
import { Policy } from "./policy";
import { Providers } from "./providers";
import { Registry } from "./registry";
import { ToolsEmpty, ToolsPageFailure } from "./states";
import { StubAction } from "./stub-action";
import { Switches, switchesOn } from "./switches";
import { ToolsTabs } from "./tabs";
import { Toolbelts } from "./toolbelts";
import {
  parseToolsView,
  type ToolsAt,
  type ToolsTab,
  type ToolsView,
} from "./view";

/**
 * An org Owner or Admin: exactly what `set_tool_classification`,
 * `set_kill_switch`, `register_mcp_server`, `delete_mcp_server`,
 * `set_approval_rules`, `set_approval_rule_enabled` and `delete_approval_rule`
 * declare at org scope. Each of those handlers asserts the same pair itself,
 * on every org tier (INV-29), so hiding their controls from anyone else hides
 * nothing the kernel would have allowed.
 *
 * `import_tools`, `register_mcp_server` and `delete_mcp_server` also declare a
 * workspace Owner. No person can satisfy that clause: `assertOrgRole` resolves
 * a workspace role from `iam.principal_role_assignments`, and nothing in the
 * tree writes one for a human (`workspace-bootstrap.ts` records the creator in
 * `workspace.workspace_users` and assigns no IAM role). So the page reads only
 * the org role, the one that is enforceable. Whether workspace membership
 * should confer IAM authority is #3198; when that lands, this reads
 * `ctx.wsRole` too.
 */
function canAdministerOrg(ctx: WsCtx): boolean {
  return ctx.orgRole === "owner" || ctx.orgRole === "admin";
}

/**
 * An org Owner, Admin, Billing or Compliance member: every role a consequence
 * can name. `grant_mandate` asserts, in its handler and on every org tier, an
 * org role the workspace names for every tag on the mandate
 * (`assertConsequenceRole`, INV-29), and both the defaults and the workspace's
 * `consequence_roles` overrides draw only from those four. The handler makes
 * the per-tag call and the dialog names its refusal.
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
 * after it can never be drawn. A read with a next page is marked partial.
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

/** The tabs that carry their own primary action, so the header yields the gold. */
const OWN_PRIMARY: ReadonlySet<ToolsTab> = new Set([
  "toolbelts",
  "providers",
  "policy",
]);

function Header({
  ctx,
  at,
  tab,
  servers,
  denyGeneration,
  members,
}: {
  ctx: WsCtx;
  at: ToolsAt;
  tab: ToolsTab;
  servers: readonly { id: string; name: string }[] | null;
  denyGeneration: { org: number; workspace: number };
  members: readonly { id: string; name: string | null; email: string }[];
}) {
  const pages = useTranslations("pages");
  const t = useTranslations("tools");
  const admin = canAdministerOrg(ctx);
  return (
    <PageHeader
      title={pages("tools")}
      eyebrow={t("eyebrow", { workspace: ctx.wsName })}
      description={t("lede")}
      actions={
        admin ? (
          <>
            <ImportProvider at={at} servers={servers} />
            <StubAction
              label={t("header.newTool")}
              tone={OWN_PRIMARY.has(tab) ? "secondary" : "primary"}
              title={t("header.wizard.title")}
              subtitle={t("header.wizard.subtitle")}
              gap="toolWizard"
              note={t("header.wizard.note")}
              confirm={t("header.wizard.confirm")}
              testId="tools-new-tool"
            >
              <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13px] text-muted-foreground">
                <li>{t("header.wizard.steps.describe")}</li>
                <li>{t("header.wizard.steps.recommend")}</li>
                <li>{t("header.wizard.steps.manifest")}</li>
                <li>{t("header.wizard.steps.code")}</li>
                <li>{t("header.wizard.steps.pr")}</li>
              </ol>
            </StubAction>
            <FlipControls
              at={at}
              denyGeneration={denyGeneration}
              existing={null}
              members={members}
            />
          </>
        ) : undefined
      }
    />
  );
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
  const admin = canAdministerOrg(ctx);
  switch (view.tab) {
    case "tools": {
      const [read, servers] = await Promise.all([
        source.tools.versions(ctx, {
          category: view.category,
          cursor: view.cursor,
          serverId: view.provider,
        }),
        source.tools.mcpServers(ctx),
      ]);
      const total = await source.tools.versions(ctx, {
        category: null,
        cursor: null,
        serverId: null,
      });
      return (
        <Registry
          at={at}
          orgRole={ctx.orgRole}
          names={view.names}
          category={view.category}
          provider={view.provider}
          cursor={view.cursor}
          canImport={admin}
          canClassify={admin}
          read={read}
          total={total.ok ? total.value : null}
          servers={servers}
        />
      );
    }
    case "toolbelts":
      return <Toolbelts at={at} canCreate={admin} />;
    case "providers": {
      // Three reads, each answered on its own: a refusal of the grants log
      // leaves the roster readable, and the other way round.
      const [servers, versions, connections, grants] = await Promise.all([
        source.tools.mcpServers(ctx),
        source.tools.versions(ctx, {
          category: null,
          cursor: null,
          serverId: null,
        }),
        source.tools.connections(ctx, { status: null, connectorId: null }),
        source.tools.grants(ctx, { cursor: view.cursor }),
      ]);
      return (
        <Providers
          at={at}
          orgRole={ctx.orgRole}
          canAdminister={admin}
          servers={servers}
          versions={versions}
          connections={connections}
          grants={grants}
          cursor={view.cursor}
        />
      );
    }
    case "policy": {
      // `list_approval_rules` admits an org Owner, Admin or Compliance; its
      // three writes an org Owner or Admin. The mandates ledger reads every
      // mandate in the workspace, and a reader who may grant also gets the
      // agents read the picker needs.
      const [rules, mandates, agents] = await Promise.all([
        source.tools.approvalRules(ctx),
        source.mandates.list(ctx, { agentId: null }),
        canGrantMandates(ctx)
          ? source.agents.list(ctx, { cursor: null })
          : Promise.resolve(null),
      ]);
      return (
        <Policy
          at={at}
          orgRole={ctx.orgRole}
          canWriteRules={admin}
          rules={rules}
          mandates={mandates}
          grant={agents === null ? null : grantableAgents(agents)}
        />
      );
    }
    case "switches": {
      // The operator scope's picker needs the org roster (#3147), and the agent
      // scope the workspace's agents; a failed read of either leaves that
      // picker with nothing to choose, which the dialog states.
      const [read, members, agents] = await Promise.all([
        source.tools.killSwitches(ctx),
        source.org.members(ctx),
        admin
          ? source.agents.list(ctx, { cursor: null })
          : Promise.resolve(null),
      ]);
      return (
        <Switches
          at={at}
          orgRole={ctx.orgRole}
          canFlip={admin}
          selfWorkspaceId={ctx.workspaceId}
          orgName={ctx.orgName}
          wsName={ctx.wsName}
          members={members.ok ? members.value.members : []}
          agents={
            agents?.ok === true
              ? agents.value.agents
                  .filter((agent) => agent.status !== "retired")
                  .map((agent) => ({
                    id: agent.id,
                    slug: agent.slug,
                    name: agent.name,
                  }))
              : []
          }
          read={read}
        />
      );
    }
  }
}

export async function Tools({
  ctx,
  source,
  tab,
  searchParams,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The tab the route resolved from its path segment or a legacy `?tab=`. */
  tab: ToolsTab;
  /** The query the URL carried: `category`, `provider`, `names`, `cursor`. */
  searchParams: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const view = parseToolsView(tab, searchParams);
  const at: ToolsAt = { org: ctx.orgSlug, ws: ctx.wsSlug };
  const [registry, servers, board, members] = await Promise.all([
    source.tools.versions(ctx, {
      category: null,
      cursor: null,
      serverId: null,
    }),
    source.tools.mcpServers(ctx),
    source.tools.killSwitches(ctx),
    canAdministerOrg(ctx) ? source.org.members(ctx) : Promise.resolve(null),
  ]);
  if (!registry.ok) {
    return <ToolsPageFailure ctx={ctx} at={at} tab={tab} read={registry} />;
  }
  const roster = servers.ok ? servers.value.servers : null;
  if (
    registry.value.items.length === 0 &&
    registry.value.nextCursor === null &&
    roster !== null &&
    roster.length === 0
  ) {
    return <ToolsEmpty at={at} canImport={canAdministerOrg(ctx)} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <Header
        ctx={ctx}
        at={at}
        tab={view.tab}
        servers={roster}
        denyGeneration={
          board.ok ? board.value.denyGeneration : { org: 0, workspace: 0 }
        }
        members={members?.ok === true ? members.value.members : []}
      />
      <ToolsTabs
        at={at}
        current={view.tab}
        versions={{
          count: registry.value.items.length,
          complete: registry.value.nextCursor === null,
        }}
        providers={roster === null ? null : roster.length}
        switchesOn={board.ok ? switchesOn(board.value.switches) : null}
        switchesOnIsFloor={board.ok && board.value.truncated}
      />
      <div
        role="tabpanel"
        id={`tools-panel-${view.tab}`}
        aria-labelledby={`tools-tab-${view.tab}`}
        className="flex flex-col gap-4"
      >
        {await TabBody({ ctx, source, view, at })}
      </div>
    </div>
  );
}

/**
 * The skeleton the route shows while the reads run: the shell stays and the
 * body is four tile blocks and a panel of seven rows, so nothing reads as a
 * zero or a stale row while the page loads.
 */
export function ToolsLoading() {
  const t = useTranslations("tools");
  // The design's `.sk` shimmer (globals.css), the one every skeleton draws.
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
