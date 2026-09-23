// Fleet (fleet.md in the roadmap's mockups): every run in the workspace, live
// and recent. The header with Steer and Register Agent, the four summary tiles,
// and the Runs panel, from one `list_runs` read, the pending approvals and the
// workspace's agents. Approvals are decided in the shell's drawer; Fleet counts
// them in one tile and opens the drawer from it.
//
// A not-loaded state replaces the page body and never the shell. The runs
// read decides it: a refusal is the access-denied state, a failure is the
// error state, and a workspace with no runs on its newest page is the empty
// state. The approvals and agents reads only feed a tile or the steer dialog,
// so either failing says so on its tile and leaves the rest of the page up.
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { canCommandRun } from "@/shared/run-command-roles";
import { PageHeader } from "@/ui/page-header";
import { type FleetAgent, FleetBoard } from "./board";
import { FleetHeaderActions } from "./header-actions";
import { FleetDenied, FleetEmpty, FleetError, FleetPending } from "./states";

async function readFleet(
  ctx: WsCtx,
  source: DataSource,
  cursor: string | null,
) {
  const [runs, approvals, agents] = await Promise.all([
    source.runs.list(ctx, { cursor }),
    source.approvals.pending(ctx, { runId: null }),
    source.agents.list(ctx, { cursor: null }),
  ]);
  // The approval clocks and the error line start from the instant the reads
  // returned; a component may not read a clock while it renders.
  return { runs, approvals, agents, now: Date.now() };
}

export async function Fleet({
  ctx,
  source,
  cursor,
  banners,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The runs page the URL asked for; null is the newest. */
  cursor: string | null;
  /** The onboarding banners the page draws under the header, when the gate has any. */
  banners?: ReactNode;
}) {
  const { runs, approvals, agents, now } = await readFleet(ctx, source, cursor);
  const org = ctx.orgSlug;
  const ws = ctx.wsSlug;
  if (!runs.ok) {
    switch (runs.reason) {
      case "denied":
        return (
          <FleetDenied
            permission={runs.permission}
            orgName={ctx.orgName}
            orgRole={ctx.orgRole}
            wsRole={ctx.wsRole}
            org={org}
            ws={ws}
          />
        );
      case "pending_approval":
        return <FleetPending accessRequestId={runs.accessRequestId} />;
      case "error":
        return (
          <FleetError code={runs.code} status={runs.status} readAt={now} />
        );
    }
  }
  if (runs.value.runs.length === 0 && cursor === null) {
    return <FleetEmpty workspace={ctx.wsName} org={org} ws={ws} />;
  }
  const roster: FleetAgent[] = agents.ok
    ? agents.value.agents.flatMap((agent) =>
        agent.agentKey === null ? [] : [{ agentKey: agent.agentKey }],
      )
    : [];
  const canCommand = canCommandRun(ctx.orgRole, ctx.wsRole);
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
            runs={runs.value.runs}
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
        approvals={approvals}
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
