// Fleet (fleet.md in the roadmap's mockups): every run in the workspace, live
// and recent. The header with Steer and Register Agent, the four summary tiles,
// and the Runs panel, from one `list_runs` read, the pending approvals, the
// open interjections and the workspace's agents. Approvals and interjections
// are listed in the shell's drawer; Fleet counts both in one tile and opens
// the drawer from it. The Runs panel's search, facets, order and page are
// values on the URL, and the runs read applies them across the workspace
// (#3837).
//
// A not-loaded state replaces the page body and never the shell. The runs
// read decides it: a refusal is the access-denied state, a failure is the
// error state, and a workspace with no runs on its newest page is the empty
// state. The approvals, interjections and agents reads only feed a tile or the
// steer dialog, so any of them failing says so on its tile and leaves the rest
// of the page up.
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { AgentPage } from "@/data/contracts/agents";
import type { PullRequestFilter } from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import { getAuthUser } from "@/features/auth";
import type { WsCtx } from "@/server/viewer";
import { canCommandRun } from "@/shared/run-command-roles";
import { PageHeader } from "@/ui/page-header";
import { type FleetAgent, FleetBoard } from "./board";
import { FleetHeaderActions } from "./header-actions";
import {
  DEFAULT_LIST_QUERY,
  type FleetListQuery,
  isUnfiltered,
  toRunsListQuery,
} from "./list-query";
import { DEFAULT_FLEET_PREFS, type FleetPrefs } from "./prefs";
import { FleetDenied, FleetEmpty, FleetError, FleetPending } from "./states";
import { parkedRunIds } from "./view";

/**
 * How many `list_agents` pages the steer dialog reads: 20 of 50, a thousand
 * agents. A workspace past that is listed to the thousandth and the dialog
 * says the list stopped, so a steer to "All" never silently leaves agents out.
 */
const AGENT_PAGES_MAX = 20;

type AgentRoster = Read<AgentPage & { complete: boolean }>;

/**
 * Every agent in the workspace, page by page. The steer dialog pre-selects
 * every agent and counts "N of M" against the workspace total, so one page
 * of 50 would steer part of a larger workspace while the tile beside it
 * counts all of it. A later page that fails stops the walk and the roster
 * says it is incomplete; only the first page's failure fails the read.
 */
async function readAgentRoster(
  ctx: WsCtx,
  source: DataSource,
): Promise<AgentRoster> {
  const first = await source.agents.list(ctx, { cursor: null });
  if (!first.ok) return first;
  const agents = [...first.value.agents];
  let next = first.value.nextCursor;
  for (let page = 1; next !== null && page < AGENT_PAGES_MAX; page += 1) {
    const read = await source.agents.list(ctx, { cursor: next });
    if (!read.ok) break;
    agents.push(...read.value.agents);
    next = read.value.nextCursor;
  }
  return {
    ok: true,
    value: {
      agents,
      nextCursor: next,
      totals: first.value.totals,
      complete: next === null,
    },
  };
}

async function readFleet(
  ctx: WsCtx,
  source: DataSource,
  list: FleetListQuery,
  at: {
    cursor: string | null;
    pageSize: number;
    pullRequests: PullRequestFilter;
  },
) {
  const [runs, approvals, interjections, agents] = await Promise.all([
    // The search, the facets, the order and the page are the read's (#3837).
    source.runs.list(ctx, toRunsListQuery(list, at)),
    source.approvals.pending(ctx, { runId: null }),
    source.interjections.open(ctx, { runId: null }),
    readAgentRoster(ctx, source),
  ]);
  // The approval clocks and the error line start from the instant the reads
  // returned; a component may not read a clock while it renders.
  return { runs, approvals, interjections, agents, now: Date.now() };
}

export async function Fleet({
  ctx,
  source,
  cursor,
  prefs = DEFAULT_FLEET_PREFS,
  pullRequests = "any",
  list = DEFAULT_LIST_QUERY,
  banners,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The runs page the URL asked for; null is the newest. */
  cursor: string | null;
  /** The columns and page size the person saved (`prefs.ts`). */
  prefs?: FleetPrefs;
  /** Runs with or without pull requests, as the URL asked. */
  pullRequests?: PullRequestFilter;
  /** The search, facets, order and page the URL asked for (`list-query.ts`). */
  list?: FleetListQuery;
  /** The onboarding banners the page draws under the header, when the gate has any. */
  banners?: ReactNode;
}) {
  const { runs, approvals, interjections, agents, now } = await readFleet(
    ctx,
    source,
    list,
    { cursor, pageSize: prefs.pageSize, pullRequests },
  );
  const org = ctx.orgSlug;
  const ws = ctx.wsSlug;
  if (!runs.ok) {
    switch (runs.reason) {
      case "denied": {
        // requireViewer admitted this request, so its memoized session is
        // present; the person is named as the shell names them.
        const user = await getAuthUser();
        return (
          <FleetDenied
            permission={runs.permission}
            decidedBy={runs.decidedBy ?? null}
            orgName={ctx.orgName}
            viewerName={user?.name || user?.email || ctx.userId}
            wsRole={ctx.wsRole}
            org={org}
            ws={ws}
          />
        );
      }
      case "pending_approval":
        return <FleetPending accessRequestId={runs.accessRequestId} />;
      case "error":
        return (
          <FleetError
            code={runs.code}
            status={runs.status}
            readAt={now}
            traceId={runs.traceId ?? null}
            region={runs.region ?? null}
            {...(runs.requestId === undefined
              ? {}
              : { requestId: runs.requestId })}
            ws={ws}
          />
        );
    }
  }
  // A filtered page with no match is not an empty workspace: the table stays,
  // with its filter, and says no run matched. Neither is a later page.
  if (
    runs.value.runs.length === 0 &&
    cursor === null &&
    pullRequests === "any" &&
    isUnfiltered(list) &&
    list.page === 1
  ) {
    return <FleetEmpty workspace={ctx.wsName} org={org} ws={ws} />;
  }
  const roster: FleetAgent[] = agents.ok
    ? agents.value.agents.flatMap((agent) =>
        agent.agentKey === null ? [] : [{ agentKey: agent.agentKey }],
      )
    : [];
  const canCommand = canCommandRun(ctx.orgRole, ctx.wsRole);
  const parked = approvals.ok ? [...parkedRunIds(approvals.value.items)] : [];
  return (
    <>
      <FleetHeader
        workspace={ctx.wsName}
        actions={
          <FleetHeaderActions
            org={org}
            ws={ws}
            workspace={ctx.wsName}
            agents={roster}
            agentsRead={agents.ok}
            agentTotal={agents.ok ? agents.value.totals.identities : null}
            agentsComplete={agents.ok && agents.value.complete}
            runs={runs.value.runs}
            parkedRunIds={parked}
            canCommand={canCommand}
          />
        }
      />
      {banners}
      <FleetBoard
        org={org}
        ws={ws}
        runs={runs.value.runs}
        nextCursor={runs.value.nextCursor}
        cursor={cursor}
        prefs={prefs}
        pullRequests={pullRequests}
        pullRequestsUnread={
          runs.value.warnings?.includes("pull_requests_unread") === true
        }
        list={list}
        {...(runs.value.total === undefined ? {} : { total: runs.value.total })}
        {...(runs.value.totalBound === undefined
          ? {}
          : { totalBound: runs.value.totalBound })}
        approvals={approvals}
        interjections={interjections}
        agentTotal={agents.ok ? agents.value.totals.identities : null}
        now={now}
        canCommand={canCommand}
      />
    </>
  );
}

/** The page header: the workspace as the eyebrow, the page's title and what it holds. */
function FleetHeader({
  workspace,
  actions,
}: {
  workspace: string;
  actions: ReactNode;
}) {
  const t = useTranslations();
  return (
    <PageHeader
      eyebrow={workspace}
      title={t("pages.fleet")}
      description={t("fleet.subtitle")}
      actions={actions}
    />
  );
}
