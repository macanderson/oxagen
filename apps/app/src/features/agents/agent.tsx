import { HarnessLabel } from "@/ui/harness-icon";
// One agent (ARCHITECTURE.md §1.2 Agents row, #2956; mockup `pAgent`): the
// identity card with its status and the writes on it, then one section chosen
// by `?tab=`. Six sections have a store behind them: Identity (get_agent),
// Toolbelt (get_agent_toolbelt), Enrollment (get_agent's hosts), Tamper
// incidents (list_incidents), Configuration (get_agent's cached commit)
// and Mandates (list_mandates narrowed to this agent, #2957). Only the chosen
// section makes its own read.
//
// Budgets is the mockup's seventh, drawn read-only (#2953). `get_spend_budget`
// has no agent scope, so the tab shows the organization and workspace ceilings
// this agent runs under and says plainly that no per-agent ceiling exists,
// rather than drawing a figure no store holds. The mockup's Runs tab still has
// no contract that reads runs per agent, so it is not drawn (§3.6).
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { AgentDetail } from "@/data/contracts/agents";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { CloneButton } from "@/ui/clone-button";
import { AgentCard } from "@/ui/agent-card";
import { panel } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { AgentActions } from "./agent-actions";
import { BudgetSection } from "./budget-panel";
import { DefinitionSection } from "./definition";
import { EnrollmentSection } from "./enrollment";
import { IdentitySection } from "./identity";
import { IncidentsSection } from "./incidents";
import { AgentKillSwitch } from "./kill-switch";
import { MandatesSection } from "./mandates";
import { AgentStatusBadge } from "./parts";
import { ToolbeltSection } from "./toolbelt";

const TABS = [
  "identity",
  "toolbelt",
  "enrollment",
  "budgets",
  "incidents",
  "definition",
  "mandates",
] as const;
type Tab = (typeof TABS)[number];

type Place = { org: string; ws: string; agent: string };

function Header({
  identity,
  org,
  ws,
  orgRole,
}: {
  identity: AgentDetail["identity"];
  org: string;
  ws: string;
  orgRole: WsCtx["orgRole"];
}) {
  const t = useTranslations("agents");
  return (
    <section
      aria-label={t("detail.header")}
      className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="flex min-w-0 flex-col gap-2">
        <AgentCard
          layout="detail"
          agentKey={identity.agentKey}
          notRecorded={t("notRecorded")}
          sub={identity.name}
        />
        <p className="flex flex-wrap items-center gap-3 text-xs">
          <AgentStatusBadge status={identity.status} />
          <HarnessLabel harness={identity.harness}>
            {t(`harness.${identity.harness}`)}
          </HarnessLabel>
        </p>
        {identity.description === null ? null : (
          <p className="max-w-prose text-sm text-muted-foreground">
            {identity.description}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <CloneButton kind="agent" sourceRef={identity.id} />
        {identity.status === "retired" ? null : (
          <>
            <AgentKillSwitch
              org={org}
              ws={ws}
              agentId={identity.id}
              agentKey={identity.agentKey}
              name={identity.name}
              orgRole={orgRole}
            />
            <AgentActions
              org={org}
              ws={ws}
              agentId={identity.id}
              name={identity.name}
              suspended={identity.status === "suspended"}
              here={routes.agent(org, ws, identity.slug)}
              list={routes.agents(org, ws)}
            />
          </>
        )}
      </div>
    </section>
  );
}

function Tabs({ selected, org, ws, agent }: { selected: Tab } & Place) {
  const t = useTranslations("agents.detail.tabs");
  return (
    <nav aria-label={t("label")} className="border-b border-border">
      <ul className="flex flex-wrap gap-1">
        {TABS.map((tab) => (
          <li key={tab}>
            <SafeLink
              to={routes.agent(org, ws, agent, { tab })}
              aria-current={tab === selected ? "page" : undefined}
              className="inline-flex min-h-10 items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground hover:text-foreground aria-[current=page]:border-foreground aria-[current=page]:text-foreground"
            >
              {t(tab)}
            </SafeLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The agent's record and the instant it was read. The credential and host
 * clocks start when the read returned, so a section is pure of `Date.now()`
 * and a state cannot disagree with the dates in the row beside it.
 */
async function readAgent(ctx: WsCtx, source: DataSource, agent: string) {
  const read = await source.agents.get(ctx, agent);
  return { read, now: Date.now() };
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
  /** `?tab=`; anything but a section's name opens Identity. */
  tab: string | null;
  /** `?cursor=`, a later page of the incidents. */
  cursor: string | null;
}) {
  const selected = TABS.find((name) => name === tab) ?? "identity";
  const { read, now } = await readAgent(ctx, source, agent);
  if (!read.ok) {
    if (read.reason === "error" && read.status === 404) notFound();
    return (
      <div className={`${panel} p-4`}>
        <ReadFailure read={read} section={agent} />
      </div>
    );
  }
  const detail = read.value;
  const { identity } = detail;
  const place = { org: ctx.orgSlug, ws: ctx.wsSlug, agent: identity.slug };
  let body: ReactNode;
  switch (selected) {
    case "identity":
      body = (
        <IdentitySection
          detail={detail}
          now={now}
          // assign_agent_role and revoke_agent_role are org Owner or Admin
          // writes (INV-29, checked in their handlers), and a retired
          // principal holds no authority to change, so the panel offers the
          // controls to nobody else.
          manage={
            (ctx.orgRole === "owner" || ctx.orgRole === "admin") &&
            identity.status !== "retired"
              ? {
                  org: place.org,
                  ws: place.ws,
                  agentId: identity.id,
                  agentSlug: identity.slug,
                }
              : null
          }
          // set_cost_center admits an org Owner, Admin or Billing member
          // (ADR-142), a wider set than the role writes, so the gate is its
          // own. A retired agent's label is left as the record holds it.
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
      break;
    case "toolbelt":
      body = (
        <ToolbeltSection
          read={await source.agents.toolbelt(ctx, identity.id)}
        />
      );
      break;
    case "enrollment":
      body = (
        <EnrollmentSection
          hosts={detail.hosts}
          now={now}
          org={place.org}
          ws={place.ws}
          agentId={identity.id}
          agentName={identity.name}
          retired={identity.status === "retired"}
          here={routes.agent(place.org, place.ws, place.agent, {
            tab: "enrollment",
          })}
        />
      );
      break;
    case "budgets":
      body = (
        <BudgetSection
          read={await source.spend.budgets(ctx)}
          spend={routes.spend(place.org, place.ws, { tab: "budgets" })}
        />
      );
      break;
    case "incidents":
      body = (
        <IncidentsSection
          read={await source.agents.incidents(ctx, identity.id, { cursor })}
          cursor={cursor}
          {...place}
        />
      );
      break;
    case "mandates":
      body = (
        <MandatesSection
          read={await source.mandates.list(ctx, { agentId: identity.id })}
          orgRole={ctx.orgRole}
          agentStatus={identity.status}
          org={place.org}
          ws={place.ws}
          agentId={identity.id}
          agentSlug={identity.slug}
        />
      );
      break;
    case "definition":
      body = (
        <DefinitionSection
          detail={detail}
          mandates={await source.mandates.list(ctx, { agentId: identity.id })}
          org={place.org}
          ws={place.ws}
          editor={routes.agentSource(place.org, place.ws, place.agent)}
          here={routes.agent(place.org, place.ws, place.agent, {
            tab: "definition",
          })}
        />
      );
      break;
  }
  return (
    <div className="flex flex-col gap-6">
      <Header
        identity={identity}
        org={place.org}
        ws={place.ws}
        orgRole={ctx.orgRole}
      />
      <Tabs selected={selected} {...place} />
      {body}
    </div>
  );
}
