// One agent (spec pages/agent.md; ARCHITECTURE.md §1.2 Agents row): the
// header, the eight tabs, and the one tab the URL names. Composition happens
// here: the registries on Tools and Steering own the reusable objects, and
// this page shows what this agent's references resolved to.
//
// The identity is read first and every other read is keyed by it
// (`agent-reads.ts`). An identity that cannot be read replaces the page body
// with the not-loaded state (`page-states.tsx`); an unknown agent is a 404.
// Every other read that fails leaves its own panel saying so and the rest of
// the page standing.
//
// The design's empty state, "This agent has never run", stands in for the
// Overview body of an enrolled agent with no frame yet. The header and the
// tabs stay, because the writes an operator needs before a first run (the
// Runtime tab's enroll path, the Definition tab, Suspend) must stay reachable;
// the other tabs carry their own empty states.
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import type { AgentDetail } from "@/data/contracts/agents";
import { isEffective } from "@/data/contracts/mandates";
import type { RunRow } from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { ActivitySection } from "./activity";
import {
  type AgentReads,
  type AgentTab,
  readAgentTab,
  runsOf,
  spendRowOf,
  tabOf,
  tamperOf,
} from "./agent-reads";
import { AgentTabs } from "./agent-tabs";
import { DefinitionSection } from "./definition";
import { AgentHeader, operatorNameOf } from "./header";
import { IdentitySection } from "./identity";
import { Overview } from "./overview";
import { AgentNeverRan, AgentPageFailure } from "./page-states";
import { PermissionsSection } from "./permissions";
import { RuntimeSection } from "./runtime";
import { SteeringSection } from "./steering-tab";
import { ToolbeltSection } from "./toolbelt";

/**
 * The agent's record and the instant it was read. The credential and host
 * clocks start when the read returned, so a section is pure of `Date.now()`
 * and a state cannot disagree with the dates in the row beside it.
 */
async function readAgent(ctx: WsCtx, source: DataSource, agent: string) {
  const read = await source.agents.get(ctx, agent);
  return { read, now: Date.now() };
}

/** The live counts on the tab strip; a count the page could not read is null and draws nothing. */
function countsOf(reads: AgentReads) {
  const list = reads.mandates.ok ? reads.mandates.value : null;
  const mandates =
    list === null
      ? null
      : list.mandates.filter((m) => isEffective(m, new Date(list.asOf))).length;
  return {
    toolbelt: reads.toolbelt.ok ? reads.toolbelt.value.tools.length : null,
    permissions: mandates,
    activity: tamperOf(reads.incidents)?.length ?? null,
  };
}

export async function Agent({
  ctx,
  source,
  agent,
  tab,
  cursor,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The agent's slug or public id, as the URL names it. */
  agent: string;
  /** Canonical section or a retained link alias. */
  tab: string | null;
  /** `?cursor=`, a later page of the incidents. */
  cursor: string | null;
}) {
  const selected = tabOf(tab);
  const { read, now } = await readAgent(ctx, source, agent);
  if (!read.ok) {
    if (read.reason === "error" && read.status === 404) notFound();
    return (
      <AgentPageFailure
        read={read}
        subject="agent"
        viewer={ctx}
        retry={routes.agent(ctx.orgSlug, ctx.wsSlug, agent, {
          tab: selected,
        })}
        readAt={new Date(now).toISOString()}
      />
    );
  }
  const detail = read.value;
  const { identity } = detail;
  const place = { org: ctx.orgSlug, ws: ctx.wsSlug, agent: identity.slug };
  const reads = await readAgentTab(ctx, source, detail, selected, cursor, now);
  const runs = runsOf(reads.runs, identity.agentKey);
  const lastRun = runs.ok ? (runs.value[0] ?? null) : null;
  const operatorName = operatorNameOf(identity, lastRun);
  const body = tabBody({
    selected,
    ctx,
    detail,
    reads,
    runs,
    lastRun,
    operatorName,
    place,
    now,
    cursor,
  });
  return (
    <div className="flex flex-col gap-5" data-testid="agent-page">
      <AgentHeader
        identity={identity}
        lastRun={lastRun}
        orgRole={ctx.orgRole}
        org={place.org}
        ws={place.ws}
      />
      <AgentTabs
        selected={selected}
        counts={countsOf(reads)}
        org={place.org}
        ws={place.ws}
        agent={place.agent}
      />
      {body}
    </div>
  );
}

function tabBody({
  selected,
  ctx,
  detail,
  reads,
  runs,
  lastRun,
  operatorName,
  place,
  now,
  cursor,
}: {
  selected: AgentTab;
  ctx: WsCtx;
  detail: AgentDetail;
  reads: AgentReads;
  runs: ReturnType<typeof runsOf>;
  lastRun: RunRow | null;
  operatorName: string | null;
  place: { org: string; ws: string; agent: string };
  now: number;
  cursor: string | null;
}): ReactNode {
  const { identity } = detail;
  const spendRow = spendRowOf(reads.spend, identity.agentKey);
  switch (selected) {
    case "overview":
      if (
        identity.firstFrameAt === null &&
        (identity.status === "enrolled" || detail.hosts.length > 0)
      ) {
        return <AgentNeverRan fleet={routes.fleet(place.org, place.ws)} />;
      }
      return (
        <Overview
          detail={detail}
          toolbelt={reads.toolbelt}
          mandates={reads.mandates}
          incidents={reads.incidents}
          deliveries={reads.deliveries}
          spend={reads.spend}
          spendRow={spendRow}
          lastRun={lastRun}
          operatorName={operatorName}
          place={place}
        />
      );
    case "identity":
      return (
        <IdentitySection
          detail={detail}
          now={now}
          lastRun={lastRun}
          operatorName={operatorName}
          incidents={reads.incidents}
          wsName={ctx.wsName}
          wsSlug={ctx.wsSlug}
          place={place}
          // set_cost_center admits an org Owner, Admin or Billing member
          // (ADR-142). A retired agent's label is left as the record holds it.
          charge={
            (ctx.orgRole === "owner" ||
              ctx.orgRole === "admin" ||
              ctx.orgRole === "billing") &&
            identity.status !== "retired"
              ? {
                  org: place.org,
                  ws: place.ws,
                  agentSlug: identity.slug,
                  agentName: identity.name,
                  costCenter: identity.costCenter,
                }
              : null
          }
        />
      );
    case "steering":
      return reads.deliveries === null ? null : (
        <SteeringSection
          deliveries={reads.deliveries}
          agentKey={identity.agentKey}
          lastRun={lastRun}
          org={place.org}
          ws={place.ws}
        />
      );
    case "toolbelt":
      return <ToolbeltSection read={reads.toolbelt} />;
    case "runtime":
      return (
        <RuntimeSection
          detail={detail}
          lastRun={lastRun}
          org={place.org}
          ws={place.ws}
          here={routes.agent(place.org, place.ws, place.agent, {
            tab: "runtime",
          })}
        />
      );
    case "permissions":
      return (
        <PermissionsSection
          detail={detail}
          toolbelt={reads.toolbelt}
          mandates={reads.mandates}
          roles={reads.roles}
          budgets={reads.budgets}
          runs={runs.ok ? runs.value : []}
          operatorName={operatorName}
          orgRole={ctx.orgRole}
          place={place}
        />
      );
    case "activity":
      return (
        <ActivitySection
          runs={runs}
          row={spendRow}
          spend={reads.spend}
          findings={reads.findings}
          incidents={reads.incidents}
          cursor={cursor}
          agentKey={identity.agentKey}
          place={place}
        />
      );
    case "definition":
      return (
        <DefinitionSection
          detail={detail}
          mandates={reads.mandates}
          org={place.org}
          ws={place.ws}
          editor={routes.agentSource(place.org, place.ws, place.agent)}
          here={routes.agent(place.org, place.ws, place.agent, {
            tab: "definition",
          })}
        />
      );
  }
}
