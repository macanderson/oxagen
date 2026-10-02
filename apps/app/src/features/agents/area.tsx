// The Agents page (roadmap mockups `agents`): the agents in this workspace and
// everything that governs them, on one page. It absorbed the Tools page and
// the Runtimes list, so its strip carries five tabs in this order: Agents,
// Tool servers, Policies, Runtimes and Off switches. The tab is the `?tab=`
// query value, not a path segment, because `/agents/<segment>` is one agent's
// page. The registry and the toolbelts are views of Tool servers
// (`?tab=tools`, `?tab=toolbelts`), so the strip lights Tool servers for them.
//
// One header serves every tab, with the mockup's three actions in its order:
// Import, Add server, and Connect an agent. Connect an agent is the page's one
// gold action; every other button is drawn in the default style. What only
// one tab writes sits in that tab's body: Add a runtime on Runtimes, and Flip
// a kill switch on Off switches.
//
// The strip counts what each tab lists: the live agents, the tool servers, the
// runtimes, and the switches denying. Policies has no count, because the
// Cedar policy files the mockup counts are not what the tab reads.
//
// One runtime opens in the drawer over the Runtimes tab (`&runtime=<id>`,
// roadmap mockups `agt-runtime`), and the tab stays behind it.
//
// The header and the strip stay on every state a tab can reach, so a person
// whose agents read failed can still open Tool servers. A tab's body carries
// its own not-loaded states and its own skeleton.
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, Suspense } from "react";
import type { DataSource } from "@/data/ports";
import {
  RuntimeInDrawer,
  Runtimes,
  RuntimesLoading,
  runtimesCount,
} from "@/features/runtimes";
import {
  ToolsBody,
  ToolsHeaderActions,
  ToolsLoading,
  toolsTabCounts,
  toolsTabOfAgentsTab,
} from "@/features/tools";
import type { WsCtx } from "@/server/viewer";
import {
  AGENTS_AREA_TABS,
  type AgentsAreaTab,
  type AgentsPageTab,
  firstParam,
  routes,
} from "@/shared/safe-path";
import { formatCount } from "@/ui/money-format";
import { PageHeader } from "@/ui/page-header";
import { RouteTabPanel, RouteTabs } from "@/ui/route-tabs";
import { Agents, AgentsLoading } from "./agents";
import { ConnectAgentLink } from "./create-actions";

const PAGE_TABS: readonly AgentsPageTab[] = [
  ...AGENTS_AREA_TABS,
  "tools",
  "toolbelts",
];

/**
 * The tab a `?tab=` names, or Agents. The Tools page's own tab ids
 * (`providers`, `policy`) land on the tab that holds them, so a link written
 * for either page never renders an empty one.
 */
export function parseAgentsPageTab(raw: string | undefined): AgentsPageTab {
  if (raw === undefined) return "agents";
  if (raw === "providers") return "servers";
  if (raw === "policy") return "policies";
  return PAGE_TABS.find((tab) => tab === raw) ?? "agents";
}

/**
 * The tab the strip lights: a Tool servers view lights Tool servers.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function areaTabOf(tab: AgentsPageTab): AgentsAreaTab {
  return tab === "tools" || tab === "toolbelts" ? "servers" : tab;
}

/** The id of the panel the page draws under the strip. */
const AGENTS_PANEL = "agents-panel";

/** What the strip counts, each null where the read did not answer. */
type Counts = {
  agents: number | null;
  servers: number | null;
  runtimes: number | null;
  switchesOn: number | null;
  switchesOnIsFloor: boolean;
};

function AgentsAreaTabs({
  org,
  ws,
  current,
  counts,
}: {
  org: string;
  ws: string;
  current: AgentsAreaTab;
  counts: Counts;
}) {
  const t = useTranslations("agents.area.tabs");
  const locale = useLocale();
  const count = (tab: AgentsAreaTab): ReactNode | undefined => {
    switch (tab) {
      case "agents":
      case "servers":
      case "runtimes": {
        const n = counts[tab];
        return n === null ? undefined : formatCount(n, locale);
      }
      case "switches":
        if (counts.switchesOn === null) return undefined;
        return (
          <span
            data-count="switches"
            className={counts.switchesOn > 0 ? "text-error-ink" : undefined}
          >
            {counts.switchesOnIsFloor
              ? t("switchesOnAtLeast", { count: counts.switchesOn })
              : t("switchesOn", { count: counts.switchesOn })}
          </span>
        );
      case "policies":
        return undefined;
    }
  };
  return (
    <RouteTabs
      label={t("label")}
      panel={AGENTS_PANEL}
      tabs={AGENTS_AREA_TABS.map((tab) => {
        const n = count(tab);
        return {
          to: routes.agents(org, ws, { tab }),
          label: t(tab),
          current: tab === current,
          name: tab,
          ...(n === undefined ? {} : { count: n }),
        };
      })}
    />
  );
}

/** The skeleton each tab's body shows while its reads run. */
function BodyLoading({ tab }: { tab: AgentsAreaTab }) {
  switch (tab) {
    case "agents":
      return <AgentsLoading />;
    case "runtimes":
      return <RuntimesLoading />;
    case "servers":
    case "policies":
    case "switches":
      return <ToolsLoading />;
  }
}

function Body({
  ctx,
  source,
  tab,
  searchParams,
  viewerName,
}: {
  ctx: WsCtx;
  source: DataSource;
  tab: AgentsPageTab;
  searchParams: Readonly<Record<string, string | string[] | undefined>>;
  viewerName: string;
}) {
  const tools = toolsTabOfAgentsTab(tab);
  if (tools !== null)
    return (
      <ToolsBody
        ctx={ctx}
        source={source}
        tab={tools}
        searchParams={searchParams}
      />
    );
  if (tab === "runtimes")
    return (
      <Runtimes
        ctx={ctx}
        source={source}
        org={ctx.orgSlug}
        ws={ctx.wsSlug}
        viewerName={viewerName}
      />
    );
  const cursor = searchParams.cursor;
  return (
    <Agents
      ctx={ctx}
      source={source}
      cursor={typeof cursor === "string" ? cursor : null}
      showRetired={searchParams.deregistered === "show"}
      viewerName={viewerName}
    />
  );
}

export async function AgentsArea({
  ctx,
  source,
  tab,
  searchParams,
  viewerName,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The tab the URL's `?tab=` resolved to (`parseAgentsPageTab`). */
  tab: AgentsPageTab;
  /** The query the URL carried; each tab reads its own values from it. */
  searchParams: Readonly<Record<string, string | string[] | undefined>>;
  /** The signed-in person's name or email, for a tab's access-denied state. */
  viewerName: string;
}) {
  const current = areaTabOf(tab);
  const [tools, agents, runtimes] = await Promise.all([
    toolsTabCounts(ctx, source),
    source.agents.list(ctx, { cursor: null, includeRetired: false }),
    runtimesCount(ctx, source),
  ]);
  const counts: Counts = {
    ...tools,
    agents: agents.ok ? agents.value.totals.identities : null,
    runtimes,
  };
  const asked = firstParam(searchParams.runtime);
  const runtime =
    tab === "runtimes" && asked !== undefined && asked !== "" ? asked : null;
  return (
    <div className="flex flex-col gap-4">
      <AreaHeader ctx={ctx} source={source} />
      <AgentsAreaTabs
        org={ctx.orgSlug}
        ws={ctx.wsSlug}
        current={current}
        counts={counts}
      />
      <RouteTabPanel panel={AGENTS_PANEL} className="flex flex-col gap-4">
        <Suspense key={tab} fallback={<BodyLoading tab={current} />}>
          <Body
            ctx={ctx}
            source={source}
            tab={tab}
            searchParams={searchParams}
            viewerName={viewerName}
          />
        </Suspense>
      </RouteTabPanel>
      {runtime === null ? null : (
        <Suspense key={runtime} fallback={null}>
          <RuntimeInDrawer
            ctx={ctx}
            source={source}
            org={ctx.orgSlug}
            ws={ctx.wsSlug}
            runtime={runtime}
            viewerName={viewerName}
          />
        </Suspense>
      )}
    </div>
  );
}

function AreaHeader({ ctx, source }: { ctx: WsCtx; source: DataSource }) {
  const t = useTranslations();
  return (
    <PageHeader
      eyebrow={ctx.wsName}
      title={t("pages.agents")}
      description={t("agents.area.description")}
      actions={
        <>
          <ToolsHeaderActions ctx={ctx} source={source} />
          <ConnectAgentLink org={ctx.orgSlug} ws={ctx.wsSlug} />
        </>
      }
    />
  );
}
