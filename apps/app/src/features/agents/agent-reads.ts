// The reads one agent page makes (spec pages/agent.md, Data sources). The
// identity comes first, because every other read is keyed by what it returns:
// the public id, the agent key a run and a spend row carry. The rest go out
// together, and each is a `Read` of its own, so one store that is down leaves
// its panel saying so and the rest of the page standing.
//
// Every tab reads the four that feed the header and the tab strip: the belt
// (the Toolbelt count), the mandates (the Permissions count), the incidents
// (the Activity count), and the newest page of runs (the tier and replay
// badges, which are the last run's recorded words). A tab then adds only what
// its own panels read.
import { TAMPER_INCIDENT_KINDS } from "@oxagen/oxagen/contracts/tacho.incident.list";
import type { AgentDetail } from "@/data/contracts/agents";
import type { DayRange } from "@/data/contracts/spend";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";

export const AGENT_TABS = [
  "overview",
  "identity",
  "steering",
  "toolbelt",
  "runtime",
  "permissions",
  "activity",
] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

/**
 * The rev1 tab ids, each landing on the tab that absorbed it (`IAM_TAB_ALIAS`).
 * `definition` was the agent's definition file, removed by ADR-198: a link to
 * it lands on the Toolbelt tab, which holds what the agent carries now.
 */
const TAB_ALIASES: Readonly<Record<string, AgentTab>> = {
  mandates: "permissions",
  budgets: "permissions",
  runs: "activity",
  incidents: "activity",
  enrollment: "runtime",
  definition: "toolbelt",
};

/** The tab a URL segment names; an alias lands on its tab and anything else on Overview. */
export function tabOf(segment: string | null): AgentTab {
  if (segment === null) return "overview";
  const canonical = Object.hasOwn(TAB_ALIASES, segment)
    ? TAB_ALIASES[segment]
    : segment;
  return AGENT_TABS.find((tab) => tab === canonical) ?? "overview";
}

/** The trailing 30 UTC days that end today, the window every 30-day figure on the page covers. */
function last30Days(now: number): DayRange {
  const day = 24 * 60 * 60 * 1000;
  const to = new Date(now).toISOString().slice(0, 10);
  const from = new Date(now - 29 * day).toISOString().slice(0, 10);
  return { from, to };
}

/** What a port method's promise settles to. */
type SourceRead<F extends (...args: never[]) => unknown> = Awaited<
  ReturnType<F>
>;

export type AgentReads = {
  toolbelt: SourceRead<DataSource["agents"]["toolbelt"]>;
  mandates: SourceRead<DataSource["mandates"]["list"]>;
  incidents: SourceRead<DataSource["agents"]["incidents"]>;
  runs: SourceRead<DataSource["runs"]["list"]>;
  /** `get_spend` at the agent level over `period`; null on a tab that shows no 30-day figure. */
  spend: SourceRead<DataSource["spend"]["byGroup"]> | null;
  /** The steering manifests of recent runs; null on a tab that does not show them. */
  deliveries: SourceRead<DataSource["steering"]["deliveries"]> | null;
  /** The open findings of the workspace; null off the Activity tab. */
  findings: SourceRead<DataSource["spend"]["findings"]> | null;
  /** The org and workspace ceilings above the agent; null off Permissions. */
  budgets: SourceRead<DataSource["spend"]["budgets"]> | null;
  /** The organization's role catalogue, for the permissions each held role carries; null off Permissions. */
  roles: SourceRead<DataSource["org"]["roles"]> | null;
  /** The workspace's toolbelts, for the belt picker (ADR-198); null off Toolbelt. */
  belts: SourceRead<DataSource["tools"]["toolbelts"]> | null;
  /** The workspace's runtimes, for the Move control (ADR-198); null off Runtime. */
  runtimes: SourceRead<DataSource["runtimes"]["named"]> | null;
  period: DayRange;
};

const SPEND_TABS: ReadonlySet<AgentTab> = new Set(["overview", "activity"]);
const DELIVERY_TABS: ReadonlySet<AgentTab> = new Set(["overview", "steering"]);

/** Everything the tab needs beyond the identity, read at once. */
export async function readAgentTab(
  ctx: WsCtx,
  source: DataSource,
  detail: AgentDetail,
  tab: AgentTab,
  cursor: string | null,
  now: number,
): Promise<AgentReads> {
  const { id, agentKey } = detail.identity;
  const period = last30Days(now);
  const none = Promise.resolve(null);
  const [
    toolbelt,
    mandates,
    incidents,
    runs,
    spend,
    deliveries,
    findings,
    budgets,
    roles,
    belts,
    runtimes,
  ] = await Promise.all([
    source.agents.toolbelt(ctx, id),
    source.mandates.list(ctx, { agentId: id }),
    source.agents.incidents(ctx, id, {
      cursor: tab === "activity" ? cursor : null,
    }),
    source.runs.list(ctx, { cursor: null }),
    SPEND_TABS.has(tab) && agentKey !== null
      ? source.spend.byGroup(ctx, "agent", period)
      : none,
    DELIVERY_TABS.has(tab) ? source.steering.deliveries(ctx) : none,
    tab === "activity" ? source.spend.findings(ctx) : none,
    tab === "permissions" ? source.spend.budgets(ctx) : none,
    tab === "permissions" ? source.org.roles(ctx) : none,
    tab === "toolbelt" ? source.tools.toolbelts(ctx) : none,
    tab === "runtime" ? source.runtimes.named(ctx) : none,
  ]);
  return {
    toolbelt,
    mandates,
    incidents,
    runs,
    spend,
    deliveries,
    findings,
    budgets,
    roles,
    belts,
    runtimes,
    period,
  };
}

/** The newest-first runs of this agent on the page of runs that was read. */
export function runsOf(
  runs: AgentReads["runs"],
  agentKey: string | null,
): Read<AgentRunRows> {
  if (!runs.ok) return runs;
  return {
    ok: true,
    value:
      agentKey === null
        ? []
        : runs.value.runs.filter((run) => run.agentKey === agentKey),
  };
}
export type AgentRunRows = Extract<
  AgentReads["runs"],
  { ok: true }
>["value"]["runs"];

/** This agent's row of the 30-day rollup, or null when the rollup holds none for it. */
export function spendRowOf(
  spend: AgentReads["spend"],
  agentKey: string | null,
) {
  if (spend === null || !spend.ok || agentKey === null) return null;
  return spend.value.rows.find((row) => row.key === agentKey) ?? null;
}

/**
 * The incidents on the page read whose kind means the record itself was
 * interfered with (`TAMPER_INCIDENT_KINDS`): the Activity count, the
 * Overview's Tamper incidents figure and the health verdict all read these,
 * so the three agree. A telemetry gap or a daemon that went down is an
 * incident and is listed, but it is not tamper.
 */
export function tamperOf(
  incidents: AgentReads["incidents"],
): IncidentRows | null {
  if (!incidents.ok) return null;
  return incidents.value.incidents.filter((incident) =>
    TAMPER.has(incident.kind),
  );
}
export type IncidentRows = Extract<
  AgentReads["incidents"],
  { ok: true }
>["value"]["incidents"];

const TAMPER: ReadonlySet<string> = new Set(TAMPER_INCIDENT_KINDS);
