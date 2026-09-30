// The Tools views (mockup `tools.md`), now tabs of the Agents page: every tool
// version the registry holds, the providers they came from, the toolbelts that
// put a tool in front of an agent, the policy that decides a call, and the
// kill switches. The chain the views make readable is Provider → Tool →
// Toolbelt → Agent. The Agents page draws the one header and the tab strip;
// this module draws a tab's body, the header's tool actions, and the counts
// the strip carries.
//
// A body reads the registry's first page before it draws anything. A refusal
// or an outage of that read replaces the tab's body and never the header, the
// strip or the shell, and a workspace with no provider and no version shows
// the empty state on the Tool servers views. Policies and Off switches do not
// hang on a provider, so they draw whatever the registry holds. The kernel
// seam serves one read per request, so a body that asks for the same record
// the header or the strip read pays nothing.
import { useTranslations } from "next-intl";
import type { AgentPage } from "@/data/contracts/agents";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { panel, statStrip, statTile } from "@/ui/control-styles";
import { FlipControls } from "./switch-controls";
import { ImportProvider } from "./import-provider";
import type { LedgerGrant } from "./mandates-ledger";
import { Policy } from "./policy";
import { Providers } from "./providers";
import { Registry } from "./registry";
import { ToolsEmpty, ToolsPageFailure } from "./states";
import { StubAction } from "./stub-action";
import { Switches, switchesOn } from "./switches";
import { isServerView, ServerViews } from "./tabs";
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
 * What the grant dialog's picker offers, from one page of `list_agents`. The
 * read leaves retired identities out (#4332), and `grant_mandate` refuses one
 * with `agent_retired`. A retired row that still arrives is left out and
 * remembered, so its requested drafts are offered no Grant: retirement
 * suspends the principal, and a mandate granted after it can never be drawn.
 * A read with a next page is marked partial.
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

/**
 * The Tools actions in the Agents page header, each in the default style
 * because Connect an agent is the page's one gold action: Import a provider
 * and New tool on every tab, and Flip a kill switch on Off switches, the tab
 * whose record it writes. An org Owner or Admin only; nobody else may write
 * what they open.
 */
export async function ToolsHeaderActions({
  ctx,
  source,
  tab,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The Tools view the Agents tab shows, or null on Agents and Runtimes. */
  tab: ToolsTab | null;
}) {
  if (!canAdministerOrg(ctx)) return null;
  const at: ToolsAt = { org: ctx.orgSlug, ws: ctx.wsSlug };
  const flips = tab === "switches";
  const [servers, board, members] = await Promise.all([
    source.tools.mcpServers(ctx),
    flips ? source.tools.killSwitches(ctx) : Promise.resolve(null),
    flips ? source.org.members(ctx) : Promise.resolve(null),
  ]);
  return (
    <ToolsHeaderButtons
      at={at}
      servers={servers.ok ? servers.value.servers : null}
      flip={
        board === null
          ? null
          : {
              denyGeneration: board.ok
                ? board.value.denyGeneration
                : { org: 0, workspace: 0 },
              members: members?.ok === true ? members.value.members : [],
            }
      }
    />
  );
}

function ToolsHeaderButtons({
  at,
  servers,
  flip,
}: {
  at: ToolsAt;
  servers: readonly { id: string; name: string }[] | null;
  flip: {
    denyGeneration: { org: number; workspace: number };
    members: readonly { id: string; name: string | null; email: string }[];
  } | null;
}) {
  const t = useTranslations("tools");
  return (
    <>
      <ImportProvider at={at} servers={servers} />
      <StubAction
        label={t("header.newTool")}
        tone="secondary"
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
      {flip === null ? null : (
        <FlipControls
          at={at}
          denyGeneration={flip.denyGeneration}
          existing={null}
          members={flip.members}
        />
      )}
    </>
  );
}

/**
 * The counts the Agents tab strip carries for the Tools tabs: the providers
 * on Tool servers and the switches denying on Off switches. Null where the
 * read did not answer, so the strip prints no figure rather than a zero.
 */
export async function toolsTabCounts(
  ctx: WsCtx,
  source: DataSource,
): Promise<{
  servers: number | null;
  switchesOn: number | null;
  switchesOnIsFloor: boolean;
}> {
  const [servers, board] = await Promise.all([
    source.tools.mcpServers(ctx),
    source.tools.killSwitches(ctx),
  ]);
  return {
    servers: servers.ok ? servers.value.servers.length : null,
    switchesOn: board.ok ? switchesOn(board.value.switches) : null,
    switchesOnIsFloor: board.ok && board.value.truncated,
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
    case "toolbelts": {
      // The list, and the belt the URL opens below it. A refusal of the one
      // leaves the other readable.
      const [list, open] = await Promise.all([
        source.tools.toolbelts(ctx),
        view.belt === null
          ? Promise.resolve(null)
          : source.tools.toolbelt(ctx, view.belt),
      ]);
      return <Toolbelts at={at} canEdit={admin} list={list} open={open} />;
    }
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

export async function ToolsBody({
  ctx,
  source,
  tab,
  searchParams,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The Tools view the Agents page's `?tab=` resolved to. */
  tab: ToolsTab;
  /** The query the URL carried: `category`, `provider`, `names`, `cursor`, `belt`. */
  searchParams: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const view = parseToolsView(tab, searchParams);
  const at: ToolsAt = { org: ctx.orgSlug, ws: ctx.wsSlug };
  const [registry, servers] = await Promise.all([
    source.tools.versions(ctx, {
      category: null,
      cursor: null,
      serverId: null,
    }),
    source.tools.mcpServers(ctx),
  ]);
  if (!registry.ok) {
    return <ToolsPageFailure ctx={ctx} at={at} tab={tab} read={registry} />;
  }
  const roster = servers.ok ? servers.value.servers : null;
  const serverView = isServerView(view.tab) ? view.tab : null;
  if (
    serverView !== null &&
    registry.value.items.length === 0 &&
    registry.value.nextCursor === null &&
    roster !== null &&
    roster.length === 0
  ) {
    return <ToolsEmpty at={at} canImport={canAdministerOrg(ctx)} />;
  }
  return (
    <div className="flex flex-col gap-4">
      {serverView === null ? null : (
        <ServerViews
          at={at}
          current={serverView}
          versions={{
            count: registry.value.items.length,
            complete: registry.value.nextCursor === null,
          }}
          providers={roster === null ? null : roster.length}
        />
      )}
      {await TabBody({ ctx, source, view, at })}
    </div>
  );
}

/**
 * The skeleton a Tools tab shows while its reads run: the header and the strip
 * stay, and the body is four tile blocks and a panel of seven rows, so nothing reads as a
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
