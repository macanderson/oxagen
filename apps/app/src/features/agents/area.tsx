// The Agents page (roadmap mockups `agents`): the agents in this workspace and
// everything that governs them, on one page. It absorbed the Tools page and
// the Runtimes list, so its strip carries five tabs in this order: Agents,
// Tool servers, Policies, Runtimes and Off switches. The tab is the `?tab=`
// query value, not a path segment, because `/agents/<segment>` is one agent's
// page. The registry and the toolbelts are views of Tool servers
// (`?tab=tools`, `?tab=toolbelts`), so the strip lights Tool servers for them.
//
// One header serves every tab. Its actions keep the labels they had on the
// pages they came from, in this order: Import a provider and New tool from
// Tools, Flip a kill switch on Off switches, Add a runtime from Runtimes, and
// Connect an agent last. Connect an agent is the page's one gold action; every
// other button is drawn in the default style.
//
// The header and the strip stay on every state a tab can reach, so a person
// whose agents read failed can still open Tool servers. A tab's body carries
// its own not-loaded states and its own skeleton.
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, Suspense } from "react";
import type { DataSource } from "@/data/ports";
import {
  AddRuntime,
  mayAddRuntime,
  Runtimes,
  RuntimesLoading,
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
  routes,
} from "@/shared/safe-path";
import { formatCount } from "@/ui/money-format";
import { PageHeader } from "@/ui/page-header";
import { RouteTabs } from "@/ui/route-tabs";
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

/** The tab the strip lights: a Tool servers view lights Tool servers. */
export function areaTabOf(tab: AgentsPageTab): AgentsAreaTab {
  return tab === "tools" || tab === "toolbelts" ? "servers" : tab;
}

/** What the strip counts, each null where the read did not answer. */
type Counts = {
  servers: number | null;
  switchesOn: number | null;
  switchesOnIsFloor: boolean;
};

export function AgentsAreaTabs({
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
      case "servers":
        return counts.servers === null
          ? undefined
          : formatCount(counts.servers, locale);
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
      case "agents":
      case "policies":
      case "runtimes":
        return undefined;
    }
  };
  return (
    <RouteTabs
      tablist
      label={t("label")}
      tabs={AGENTS_AREA_TABS.map((tab) => {
        const n = count(tab);
        return {
          to: routes.agents(org, ws, { tab }),
          label: t(tab),
          current: tab === current,
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
  const counts = await toolsTabCounts(ctx, source);
  return (
    <div className="flex flex-col gap-4">
      <AreaHeader ctx={ctx} source={source} tab={tab} />
      <AgentsAreaTabs
        org={ctx.orgSlug}
        ws={ctx.wsSlug}
        current={current}
        counts={counts}
      />
      <div
        role="tabpanel"
        id={`agents-panel-${current}`}
        className="flex flex-col gap-4"
      >
        <Suspense key={tab} fallback={<BodyLoading tab={current} />}>
          <Body
            ctx={ctx}
            source={source}
            tab={tab}
            searchParams={searchParams}
            viewerName={viewerName}
          />
        </Suspense>
      </div>
    </div>
  );
}

function AreaHeader({
  ctx,
  source,
  tab,
}: {
  ctx: WsCtx;
  source: DataSource;
  tab: AgentsPageTab;
}) {
  const t = useTranslations();
  return (
    <PageHeader
      eyebrow={ctx.wsName}
      title={t("pages.agents")}
      description={t("agents.area.description")}
      actions={
        <>
          <ToolsHeaderActions
            ctx={ctx}
            source={source}
            tab={toolsTabOfAgentsTab(tab)}
          />
          {mayAddRuntime(ctx) ? (
            <AddRuntime org={ctx.orgSlug} ws={ctx.wsSlug} gold={false} />
          ) : null}
          <ConnectAgentLink org={ctx.orgSlug} ws={ctx.wsSlug} />
        </>
      }
    />
  );
}
