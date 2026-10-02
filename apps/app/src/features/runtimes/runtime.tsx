// One runtime, in the drawer over the Agents page's Runtimes tab (roadmap
// mockups `agt-runtime`), opened by `?tab=runtimes&runtime=<id>`. The id is
// one of two public ids, and each draws its own body:
//
// - A host enrollment (`tch_…`): the host, the agents on it, and how to roll
//   it back, because the enrollment is the row the record holds for a machine.
// - A named runtime (`rtm_…`, ADR-198): the slot hosts enroll against, its
//   agents, and its containment (ADR-204). An org Owner or Admin changes
//   containment here with a switch; everyone else reads the value.
//
// An id the workspace does not hold opens the drawer on a sentence that says
// so, and the tab stays behind it.
import { runtimeIdSchema } from "@oxagen/oxagen/contracts/runtime.shared";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  NamedRuntime,
  RuntimeAgent,
  RuntimeAgents,
  RuntimeEnrollment,
} from "@/data/contracts/runtimes";
import type { MemberList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { AgentCard } from "@/ui/agent-card";
import { mono, panelBody } from "@/ui/control-styles";
import { type ListRow, ListTable } from "@/ui/list-table";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { type OperatorIdentity, OperatorName } from "@/ui/operator";
import { ReadFailure } from "@/ui/read-failure";
import { cell } from "@/ui/table";
import { ContainmentSwitch, SmokeSession, Unenroll } from "./controls";
import { RuntimeDrawer } from "./drawer";
import { AgentsCell, LastSeen } from "./named";
import {
  COMMAND_HOOKS,
  Facts,
  HarnessLabel,
  HarnessNames,
  HealthBadge,
  hooksReadBack,
  ModelSurface,
  NotBacked,
  Note,
  OsLine,
  Panel,
  Sub,
} from "./parts";
import { mayAddRuntime } from "./runtimes";
import { RuntimesFailure } from "./states";

function HostPanel({
  host,
  wsName,
  now,
}: {
  host: RuntimeEnrollment;
  wsName: string;
  now: number;
}) {
  const t = useTranslations("runtimes");
  const facts: { term: string; value: ReactNode; testId: string }[] = [
    {
      term: t("detail.facts.workspace"),
      value: wsName,
      testId: "fact-workspace",
    },
    {
      term: t("detail.facts.owner"),
      value: <span className={mono}>{host.osUser}</span>,
      testId: "fact-owner",
    },
    {
      term: t("detail.facts.harness"),
      value: <HarnessNames host={host} />,
      testId: "fact-harness",
    },
    {
      term: t("detail.facts.collector"),
      value: (
        <>
          {host.collectorVersion === null ? (
            <span className="text-muted-foreground">{t("notReported")}</span>
          ) : (
            <span className={mono}>
              {t("hosts.collector", { version: host.collectorVersion })}
            </span>
          )}
          <Sub monoFace>
            <NotBacked gap="gaps">{t("detail.collectorGaps")}</NotBacked>
          </Sub>
        </>
      ),
      testId: "fact-collector",
    },
    {
      term: t("detail.facts.hookBinary"),
      // The hook ships with the collector, so it carries the collector's
      // version. An observe-mode host allows on a stale bundle, so "fails
      // closed" is printed only for enforce mode.
      value:
        host.collectorVersion === null ? (
          <span className="text-muted-foreground">{t("notReported")}</span>
        ) : (
          <span className={mono}>
            {t(
              host.mode === "enforce"
                ? "detail.hookEnforce"
                : "detail.hookObserve",
              { version: host.collectorVersion },
            )}
          </span>
        ),
      testId: "fact-hook-binary",
    },
    {
      term: t("detail.facts.hooksWritten"),
      // The list the collector read back, when the record holds all five;
      // otherwise not recorded (#3818).
      value: hooksReadBack(host) ? (
        <>
          <span className={`${mono} text-sm`}>{COMMAND_HOOKS}</span>
          <Sub>{t("detail.hooksFive")}</Sub>
        </>
      ) : (
        <NotBacked gap="hooks" />
      ),
      testId: "fact-hooks-written",
    },
    {
      term: t("detail.facts.modelSurface"),
      value: (
        <>
          <ModelSurface host={host} />
          {host.modelRoute === null ? null : (
            <Sub>
              {host.modelRoute === "loopback"
                ? t("detail.modelLoopback")
                : host.modelRoute === "mixed"
                  ? t("detail.modelMixed")
                  : t("detail.modelDirect")}
            </Sub>
          )}
        </>
      ),
      testId: "fact-model-surface",
    },
    {
      term: t("detail.facts.settings"),
      // Where the installer wrote the hooks, as recorded at enrollment.
      value: t(
        host.managed ? "detail.settings.managed" : "detail.settings.user",
      ),
      testId: "fact-settings",
    },
    {
      term: t("detail.facts.tierEarned"),
      value: (
        <>
          <NotBacked gap="tier" />
          <Sub>{t("detail.tierBasis")}</Sub>
        </>
      ),
      testId: "fact-tier",
    },
    {
      term: t("detail.facts.checkpoint"),
      value: <NotBacked gap="checkpoint" />,
      testId: "fact-checkpoint",
    },
  ];
  return (
    <Panel
      id="runtime-host"
      title={host.hostname}
      titleNode={
        // Three facts, one per item, so no mid-dot joins them into a label.
        <ul
          data-testid="runtime-subtitle"
          className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground"
        >
          {t.rich("detail.subtitle", {
            kind: () => (
              <li>
                <NotBacked gap="host">{t("detail.kindUnrecorded")}</NotBacked>
              </li>
            ),
            os: () => (
              <li>
                <OsLine host={host} />
              </li>
            ),
            who: (chunks) => (
              <li>
                {chunks} <NotBacked gap="host" />
              </li>
            ),
          })}
        </ul>
      }
      aside={
        <HealthBadge host={host} now={now}>
          {t("detail.healthUnrecorded")}
        </HealthBadge>
      }
    >
      <div className={panelBody}>
        <Facts rows={facts} />
      </div>
    </Panel>
  );
}

/**
 * The agent's operator, named from the organization's roster. `list_agents`
 * carries the operator's `usr_…` id and no name, so the name comes from the
 * members read, the way Spend and Audit name a person. The id is never the
 * label: it stays in the hover card, copyable. A roster that did not load, or
 * that does not hold the id, leaves the name unknown rather than guessed.
 */
function operatorOf(
  operatorId: string,
  members: Read<MemberList>,
): OperatorIdentity {
  const member = members.ok
    ? members.value.members.find((m) => m.id === operatorId)
    : undefined;
  if (member === undefined) return { id: operatorId, name: null, kind: null };
  return {
    id: operatorId,
    name: member.name,
    kind: "human",
    email: member.email,
    avatarUrl: member.avatarUrl,
  };
}

/** The one agent on this enrollment as a list row: Agent, Operator, Tier, Principal, Runs 30d. */
function agentRow({
  agent,
  agentKey,
  members,
  org,
  ws,
  words,
}: {
  agent: RuntimeAgent | null;
  agentKey: string;
  members: Read<MemberList>;
  org: string;
  ws: string;
  words: { notRecorded: string; unknown: string; runs: string | null };
}): ListRow {
  const card = (
    <AgentCard
      agentKey={agentKey}
      harness={agent?.harness}
      notRecorded={words.notRecorded}
      // The design's `agentCard` names the harness under the key.
      sub={
        agent === null ? (
          words.unknown
        ) : (
          <HarnessLabel harness={agent.harness} />
        )
      }
    />
  );
  const notRecorded = (
    <span className="text-muted-foreground">{words.notRecorded}</span>
  );
  return {
    key: agentKey,
    data: { "data-testid": "runtime-agent-row" },
    className: agent === null ? undefined : "relative cursor-pointer",
    cells: [
      // A row opens the agent: the card's link is stretched over the row,
      // and the operator cell sits above it so its identity card still opens.
      agent === null ? (
        card
      ) : (
        <SafeLink
          key="agent"
          to={routes.agent(org, ws, agent.slug)}
          data-touch-target=""
          className="inline-flex items-center rounded-sm after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-ring"
        >
          {card}
        </SafeLink>
      ),
      agent === null || agent.operatorId === null ? (
        notRecorded
      ) : (
        <OperatorName
          key="operator"
          operator={operatorOf(agent.operatorId, members)}
          testId="runtime-operator"
        />
      ),
      <NotBacked key="tier" gap="tier" />,
      agent === null || agent.principalId === null ? (
        notRecorded
      ) : (
        <span key="principal" className={`${mono} text-xs`}>
          {agent.principalId}
        </span>
      ),
      words.runs ?? notRecorded,
    ],
  };
}

function AgentsPanel({
  host,
  agents,
  members,
  org,
  ws,
}: {
  host: RuntimeEnrollment;
  agents: Read<RuntimeAgents>;
  members: Read<MemberList>;
  org: string;
  ws: string;
}) {
  const t = useTranslations("runtimes.detail.agents");
  const tr = useTranslations("runtimes");
  const locale = useLocale();
  const assigned = host.agentKey !== "";
  const agent = agents.ok
    ? (agents.value.agents.find((a) => a.agentKey === host.agentKey) ?? null)
    : null;
  return (
    <Panel id="runtime-agents" title={t("title")} count={assigned ? 1 : 0}>
      {!assigned ? (
        <p
          data-testid="runtime-agents-none"
          className={`${panelBody} text-sm text-muted-foreground`}
        >
          {t("none")}
        </p>
      ) : (
        <>
          {agents.ok ? null : (
            <div data-testid="runtime-agents-failed" className={panelBody}>
              <ReadFailure read={agents} section={t("title")} />
            </div>
          )}
          <ListTable
            label={t("title")}
            columns={[
              { label: t("columns.agent") },
              {
                label: t("columns.operator"),
                className: `${cell} relative z-[1]`,
              },
              { label: t("columns.tier") },
              { label: t("columns.principal") },
              { label: t("columns.runs"), numeric: true },
            ]}
            rows={[
              agentRow({
                agent,
                agentKey: host.agentKey,
                members,
                org,
                ws,
                words: {
                  notRecorded: tr("notRecorded"),
                  unknown: t("unknown"),
                  runs:
                    agent === null ? null : formatCount(agent.runs30d, locale),
                },
              }),
            ]}
          />
        </>
      )}
      <Note>{t("note")}</Note>
    </Panel>
  );
}

function RollbackPanel({
  host,
  agent,
  org,
  ws,
}: {
  host: RuntimeEnrollment;
  agent: string;
  org: string;
  ws: string;
}) {
  const t = useTranslations("runtimes.detail.rollback");
  const code = (chunks: ReactNode) => <code className={mono}>{chunks}</code>;
  return (
    <Panel id="runtime-rollback" title={t("title")}>
      <div className={`${panelBody} flex flex-col gap-3`}>
        <pre
          data-testid="runtime-unenroll-command"
          className={`${mono} overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted px-3.5 py-3 text-xs`}
        >
          {t("command", { agent, id: host.id })}
        </pre>
        <p className="border-l-2 border-accent-text pl-3 text-sm text-muted-foreground">
          {t.rich("note", { code })}
        </p>
        <div className="flex flex-wrap gap-2">
          <SmokeSession hostname={host.hostname} />
          {/* Offered on a revoked host too: the write is idempotent, and a
              second revoke sweeps any key the first left behind. */}
          <Unenroll
            org={org}
            ws={ws}
            runtimeId={host.id}
            hostname={host.hostname}
            agent={host.agentKey}
          />
        </div>
      </div>
    </Panel>
  );
}

/** A host enrollment's drawer body. */
function RuntimeLoaded({
  host,
  agents,
  members,
  org,
  ws,
  wsName,
  now,
}: {
  host: RuntimeEnrollment;
  agents: Read<RuntimeAgents>;
  members: Read<MemberList>;
  org: string;
  ws: string;
  wsName: string;
  now: number;
}) {
  const agent = agents.ok
    ? agents.value.agents.find((a) => a.agentKey === host.agentKey)
    : undefined;
  return (
    <>
      <HostPanel host={host} wsName={wsName} now={now} />
      <AgentsPanel
        host={host}
        agents={agents}
        members={members}
        org={org}
        ws={ws}
      />
      <RollbackPanel
        host={host}
        agent={
          agent?.slug ?? (host.agentKey.split(".").at(-1) || host.agentKey)
        }
        org={org}
        ws={ws}
      />
    </>
  );
}

/** A named runtime's own facts: its slug, its agents, its live hosts, and when one last reported. */
function NamedFactsPanel({ runtime }: { runtime: NamedRuntime }) {
  const t = useTranslations("runtimes");
  const locale = useLocale();
  const facts: { term: string; value: ReactNode; testId: string }[] = [
    {
      term: t("add.slug"),
      value: <span className={mono}>{runtime.slug}</span>,
      testId: "fact-slug",
    },
    {
      term: t("named.columns.agents"),
      value: <AgentsCell runtime={runtime} />,
      testId: "fact-agents",
    },
    {
      term: t("named.columns.hosts"),
      value: formatCount(runtime.liveHosts, locale),
      testId: "fact-live-hosts",
    },
    {
      term: t("named.columns.lastSeen"),
      value: <LastSeen at={runtime.lastSeenAt} />,
      testId: "fact-last-seen",
    },
  ];
  return (
    <Panel id="named-runtime-facts" title={runtime.name}>
      <div className={panelBody}>
        <Facts rows={facts} />
      </div>
    </Panel>
  );
}

/**
 * Containment (ADR-204): whether every agent on this runtime runs only under
 * the contained launcher. An org Owner or Admin gets the switch; everyone
 * else reads the value and who can change it.
 */
function ContainmentPanel({
  runtime,
  org,
  ws,
  canEdit,
}: {
  runtime: NamedRuntime;
  org: string;
  ws: string;
  canEdit: boolean;
}) {
  const t = useTranslations("runtimes.containment");
  return (
    <Panel id="runtime-containment" title={t("title")}>
      <div
        data-testid="runtime-containment"
        className={`${panelBody} flex flex-col gap-3 text-sm`}
      >
        <p className="text-muted-foreground">{t("lead")}</p>
        {canEdit ? (
          <ContainmentSwitch
            org={org}
            ws={ws}
            runtimeId={runtime.id}
            required={runtime.containmentRequired}
          />
        ) : (
          <Facts
            rows={[
              {
                term: t("term"),
                value: (
                  <>
                    {runtime.containmentRequired
                      ? t("required")
                      : t("notRequired")}
                    <Sub>{t("readOnly")}</Sub>
                  </>
                ),
                testId: "runtime-containment-value",
              },
            ]}
          />
        )}
      </div>
      <Note>{t("note")}</Note>
    </Panel>
  );
}

/** A named runtime's drawer body. */
function NamedRuntimeLoaded({
  runtime,
  org,
  ws,
  canEdit,
}: {
  runtime: NamedRuntime;
  org: string;
  ws: string;
  canEdit: boolean;
}) {
  return (
    <>
      <NamedFactsPanel runtime={runtime} />
      <ContainmentPanel
        runtime={runtime}
        org={org}
        ws={ws}
        canEdit={canEdit}
      />
    </>
  );
}

/** A named runtime's id (`rtm_…`, ADR-198), as against a host enrollment's (`tch_…`). */
const NAMED_RUNTIME_ID = /^rtm_/;
/**
 * Reads the one runtime by id. Looking it up in the unfiltered list would miss
 * a runtime sorted past that read's 500 cap and answer 404 for it. An id the
 * contract would refuse names no runtime, so it is a 404 without a read.
 */
async function readNamedRuntime(
  ctx: WsCtx,
  source: DataSource,
  runtime: string,
) {
  if (!runtimeIdSchema.safeParse(runtime).success)
    return { state: "missing" as const, now: Date.now() };
  const named = await source.runtimes.named(ctx, runtime);
  if (!named.ok)
    return { state: "failed" as const, read: named, now: Date.now() };
  const found = named.value.runtimes.find((row) => row.id === runtime);
  if (found === undefined)
    return { state: "missing" as const, now: Date.now() };
  return { state: "named" as const, runtime: found, now: Date.now() };
}

async function readRuntime(ctx: WsCtx, source: DataSource, runtime: string) {
  const list = await source.runtimes.list(ctx);
  if (!list.ok)
    return { state: "failed" as const, read: list, now: Date.now() };
  const host = list.value.enrollments.find((row) => row.id === runtime);
  if (host === undefined) return { state: "missing" as const, now: Date.now() };
  // A host with no agent has no operator to name, so it reads neither.
  const [agents, members]: [Read<RuntimeAgents>, Read<MemberList>] =
    host.agentKey === ""
      ? [
          { ok: true, value: { agents: [] } },
          { ok: true, value: { members: [], invitations: [] } },
        ]
      : await Promise.all([
          source.runtimes.agents(ctx, [host.agentKey]),
          source.org.members(ctx),
        ]);
  return { state: "found" as const, host, agents, members, now: Date.now() };
}

/**
 * The runtime drawer over the Runtimes tab. A failed read opens it on the
 * failure, and an id the workspace does not hold on a sentence saying so,
 * because the tab behind it is still worth keeping.
 */
export async function RuntimeInDrawer({
  ctx,
  source,
  org,
  ws,
  runtime,
  viewerName,
}: {
  ctx: WsCtx;
  source: DataSource;
  org: string;
  ws: string;
  runtime: string;
  /** The signed-in person's name or email, for the access-denied state. */
  viewerName: string;
}) {
  const read = NAMED_RUNTIME_ID.test(runtime)
    ? await readNamedRuntime(ctx, source, runtime)
    : await readRuntime(ctx, source, runtime);
  return (
    <DrawerFor
      read={read}
      ctx={ctx}
      org={org}
      ws={ws}
      viewerName={viewerName}
    />
  );
}

function DrawerFor({
  read,
  ctx,
  org,
  ws,
  viewerName,
}: {
  read:
    | Awaited<ReturnType<typeof readNamedRuntime>>
    | Awaited<ReturnType<typeof readRuntime>>;
  ctx: WsCtx;
  org: string;
  ws: string;
  viewerName: string;
}) {
  const t = useTranslations("runtimes.drawer");
  const closeTo = routes.runtimes(org, ws);
  if (read.state === "failed")
    return (
      <RuntimeDrawer title={t("title")} closeTo={closeTo}>
        <RuntimesFailure
          read={read.read}
          org={org}
          ws={ws}
          orgName={ctx.orgName}
          wsSlug={ctx.wsSlug}
          wsRole={ctx.wsRole}
          viewerName={viewerName}
          readAt={read.now}
        />
      </RuntimeDrawer>
    );
  if (read.state === "missing")
    return (
      <RuntimeDrawer title={t("title")} closeTo={closeTo}>
        <p
          data-testid="runtime-missing"
          className="text-sm text-muted-foreground"
        >
          {t("missing")}
        </p>
      </RuntimeDrawer>
    );
  const canEdit = mayAddRuntime(ctx);
  if (read.state === "named")
    return (
      <RuntimeDrawer
        title={read.runtime.name}
        subtitle={read.runtime.slug}
        closeTo={closeTo}
      >
        <NamedRuntimeLoaded
          runtime={read.runtime}
          org={org}
          ws={ws}
          canEdit={canEdit}
        />
      </RuntimeDrawer>
    );
  return (
    <RuntimeDrawer title={read.host.hostname} closeTo={closeTo}>
      <RuntimeLoaded
        host={read.host}
        agents={read.agents}
        members={read.members}
        org={org}
        ws={ws}
        wsName={ctx.wsName}
        now={read.now}
      />
    </RuntimeDrawer>
  );
}
