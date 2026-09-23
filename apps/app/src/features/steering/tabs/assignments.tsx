// Assignments: which agent receives what (roadmap
// pages/steering-assignments.md). The lead note, "What each agent receives"
// with one row per agent set up for steering, the Scope panel and the closing
// note, or "No agent receives steering here" when no agent is enrolled.
//
// What is read today: the enrolled agents from the agent registry
// (list_agents, ../agents-read.ts), and the published records' scope from the
// record registry (list_records, ../library-read.ts). What is not: the
// assembly itself. No capability runs assembleSteering for one agent and one
// prompt (#3879), so the Repository, Delivery, Gates, Stable prefix,
// Volatile, Cut, Skills and Per run cells print "not recorded" under a
// NotBacked panel naming the issue, and never a figure. A row still links to
// its agent and opens the Compiler on it, which is the one place its assembly
// will be drawn in full. Only records carry a scope today (#3830), so the
// Scope panel counts records and says the other sources wait on that read.
//
// The per-run delivery report the manifests record (get_steering_deliveries)
// stays under the spec's panels: it is what a run actually received, which
// the design's rows will be checked against once the assembly is read.
import { useTranslations } from "next-intl";
import type { RecordPage } from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { AgentCard } from "@/ui/agent-card";
import { Badge } from "@/ui/badge";
import { buttonSecondary } from "@/ui/control-styles";
import { ListTable, type ListRow } from "@/ui/faceted-list-table";
import { SafeLink } from "@/ui/navigation";
import { cell, numericCell } from "@/ui/table";
import { readSteeringAgents, type SteeringAgents } from "../agents-read";
import { Deliveries } from "../deliveries";
import { STEERING_GAPS } from "../gaps";
import { readLibrary } from "../library-read";
import { NotBacked } from "../not-backed";
import { TabEmpty } from "../page-state";
import { SteeringReadFailure } from "../read-failure";
import { code, Note, TabPanel, Unrecorded } from "../tab-parts";
import { type SteeringAt, steeringLink } from "../view";

/** The scopes an item can carry, in the design's order. */
export const SCOPES = ["org", "workspace", "repository", "agent"] as const;
export type Scope = (typeof SCOPES)[number];

/** Items per scope over the records read, in the design's order; a scope with none is left out. */
export function scopeCounts(
  records: RecordPage["records"],
): { scope: Scope; items: number }[] {
  const counts = new Map<Scope, number>();
  for (const record of records) {
    counts.set(record.sharingScope, (counts.get(record.sharingScope) ?? 0) + 1);
  }
  return SCOPES.flatMap((scope) => {
    const items = counts.get(scope) ?? 0;
    return items === 0 ? [] : [{ scope, items }];
  });
}

export async function AssignmentsTab({
  ctx,
  source,
  at,
}: {
  ctx: WsCtx;
  source: DataSource;
  at: SteeringAt;
}) {
  const [agents, library, deliveries] = await Promise.all([
    readSteeringAgents(ctx, source),
    readLibrary(ctx, source),
    source.steering.deliveries(ctx),
  ]);
  if (agents.ok && agents.value.enrolled === 0) {
    return <AssignmentsEmpty at={at} />;
  }
  return (
    <AssignmentsBody
      at={at}
      agents={agents}
      library={library}
      deliveries={deliveries}
    />
  );
}

/** "No agent receives steering here"; its action opens Agents and is not gold. */
function AssignmentsEmpty({ at }: { at: SteeringAt }) {
  const t = useTranslations("steering.bodies.assignments.empty");
  return (
    <TabEmpty
      testId="assignments-empty"
      title={t("title")}
      action={
        <SafeLink to={routes.agents(at.org, at.ws)} className={buttonSecondary}>
          {t("action")}
        </SafeLink>
      }
    >
      {t("body")}
    </TabEmpty>
  );
}

function Receives({
  at,
  read,
}: {
  at: SteeringAt;
  read: Read<SteeringAgents>;
}) {
  const t = useTranslations("steering.bodies.assignments");
  const harness = useTranslations("agents.harness");
  const title = t("receivesTitle");
  if (!read.ok) {
    return (
      <TabPanel id="assignments-receives" title={title}>
        <div className="px-4 py-3.5">
          <SteeringReadFailure read={read} section={title} />
        </div>
      </TabPanel>
    );
  }
  const { agents, truncated } = read.value;
  const unrecorded = <Unrecorded issue={STEERING_GAPS.assembler} />;
  const rows: ListRow[] = agents.map((agent) => ({
    key: agent.id,
    values: {
      agent: `${agent.agentKey ?? ""} ${agent.name} ${harness(agent.harness)}`,
      repository: null,
      delivery: null,
      gates: null,
      prefix: null,
      volatile: null,
      cut: null,
      skills: null,
      perRun: null,
      action: null,
    },
    node: (
      <tr key={agent.id} data-agent={agent.slug}>
        <td className={cell}>
          <SafeLink
            to={routes.agent(at.org, at.ws, agent.slug)}
            className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
          >
            <AgentCard
              agentKey={agent.agentKey}
              notRecorded={agent.name}
              sub={harness(agent.harness)}
            />
          </SafeLink>
        </td>
        <td className={cell}>{unrecorded}</td>
        <td className={cell} data-cell="delivery">
          {unrecorded}
        </td>
        <td className={numericCell}>{unrecorded}</td>
        <td className={numericCell}>{unrecorded}</td>
        <td className={numericCell}>{unrecorded}</td>
        <td className={numericCell}>{unrecorded}</td>
        <td className={numericCell}>{unrecorded}</td>
        <td className={numericCell}>{unrecorded}</td>
        <td className={cell}>
          <SafeLink
            to={steeringLink(at, { tab: "compiler", agent: agent.slug })}
            className={`${buttonSecondary} whitespace-nowrap`}
            data-open-compiler={agent.slug}
          >
            {t("openCompiler")}
          </SafeLink>
        </td>
      </tr>
    ),
  }));
  return (
    <TabPanel
      id="assignments-receives"
      title={title}
      testId="assignments-receives"
      badge={
        <Badge tone="quiet" dot={false} data-testid="assignments-count">
          {t("agentsBadge", { count: agents.length })}
        </Badge>
      }
      actions={
        <SafeLink
          to={steeringLink(at, { tab: "library" })}
          className={buttonSecondary}
        >
          {t("openLibrary")}
        </SafeLink>
      }
    >
      <ListTable
        testId="assignments-list"
        label={title}
        columns={[
          { key: "agent", label: t("columns.agent") },
          { key: "repository", label: t("columns.repository") },
          { key: "delivery", label: t("columns.delivery") },
          { key: "gates", label: t("columns.gates"), numeric: true },
          { key: "prefix", label: t("columns.prefix"), numeric: true },
          { key: "volatile", label: t("columns.volatile"), numeric: true },
          { key: "cut", label: t("columns.cut"), numeric: true },
          { key: "skills", label: t("columns.skills"), numeric: true },
          { key: "perRun", label: t("columns.perRun"), numeric: true },
          { key: "action", label: t("columns.action") },
        ]}
        rows={rows}
      />
      <div className="flex flex-col gap-2 border-t border-border px-4 py-3.5">
        {truncated ? (
          <Note testId="assignments-truncated">
            {t("truncated", { read: String(agents.length) })}
          </Note>
        ) : null}
        <Note testId="assignments-panel-note">{t("panelNote")}</Note>
      </div>
    </TabPanel>
  );
}

function ScopePanel({ read }: { read: Read<RecordPage> }) {
  const t = useTranslations("steering.bodies.assignments");
  const title = t("scopeTitle");
  const closing = <Note testId="assignments-closing">{t("closing")}</Note>;
  if (!read.ok) {
    return (
      <TabPanel id="assignments-scope" title={title}>
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <SteeringReadFailure read={read} section={title} />
          {closing}
        </div>
      </TabPanel>
    );
  }
  const counts = scopeCounts(read.value.records);
  const items = counts.reduce((sum, row) => sum + row.items, 0);
  const rows: ListRow[] = counts.map(({ scope, items: n }) => ({
    key: scope,
    values: { scope, items: n, reaches: t(`reaches.${scope}`) },
    node: (
      <tr key={scope} data-scope={scope}>
        <td className={cell}>
          <Badge tone="quiet" dot={false} mono>
            {scope}
          </Badge>
        </td>
        <td className={numericCell}>{n}</td>
        <td className={cell}>{t(`reaches.${scope}`)}</td>
      </tr>
    ),
  }));
  return (
    <TabPanel
      id="assignments-scope"
      title={title}
      testId="assignments-scope"
      badge={
        <Badge tone="quiet" dot={false} data-testid="scope-count">
          {t("itemsBadge", { count: items })}
        </Badge>
      }
    >
      <ListTable
        testId="scope-list"
        label={title}
        columns={[
          { key: "scope", label: t("scopeColumns.scope") },
          { key: "items", label: t("scopeColumns.items"), numeric: true },
          { key: "reaches", label: t("scopeColumns.reaches") },
        ]}
        rows={rows}
      />
      <div className="flex flex-col gap-2 border-t border-border px-4 py-3.5">
        <NotBacked
          testId="scope-not-backed"
          what={t("scopeWhat")}
          issue={STEERING_GAPS.registry}
        />
        {closing}
      </div>
    </TabPanel>
  );
}

function AssignmentsBody({
  at,
  agents,
  library,
  deliveries,
}: {
  at: SteeringAt;
  agents: Read<SteeringAgents>;
  library: Read<RecordPage>;
  deliveries: Awaited<ReturnType<DataSource["steering"]["deliveries"]>>;
}) {
  const t = useTranslations("steering.bodies.assignments");
  return (
    <div className="flex flex-col gap-3.5" data-testid="tab-assignments">
      <Note testId="assignments-lead">{t.rich("lead", { code })}</Note>
      <NotBacked
        testId="assignments-not-backed"
        what={t("what")}
        issue={STEERING_GAPS.assembler}
      />
      <Receives at={at} read={agents} />
      <ScopePanel read={library} />
      <Deliveries read={deliveries} />
    </div>
  );
}
