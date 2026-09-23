// One runtime (mockup `rtDetail()`): the host, the agents on it, and how to roll
// it back. Reached at /[org]/[ws]/runtimes/[runtime], where the segment is the
// enrollment's public id (`tch_…`), because the enrollment is the row the
// record holds.
//
// The spec's detail has no empty state: an id the list does not hold is a 404.
import { notFound } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  RuntimeAgent,
  RuntimeAgents,
  RuntimeEnrollment,
} from "@/data/contracts/runtimes";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { AgentCard } from "@/ui/agent-card";
import { buttonSecondary, mono, panelBody } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { OperatorName } from "@/ui/operator";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { SmokeSession, Unenroll } from "./controls";
import {
  Facts,
  HarnessNames,
  HealthBadge,
  healthOf,
  ModelSurface,
  NotBacked,
  Note,
  Panel,
  Sub,
} from "./parts";
import { RuntimesHeader } from "./runtimes";
import { RuntimesFailure } from "./states";

function hooksReportKey(ok: boolean | null) {
  if (ok === null) return "unreported" as const;
  return ok ? ("ok" as const) : ("missing" as const);
}

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
            <NotBacked gap="gaps" />
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
      value:
        host.collectorVersion === null ? (
          <NotBacked gap="gaps" />
        ) : (
          <span className={mono}>
            {t("detail.hookBinary", { version: host.collectorVersion })}
            <Sub>
              {host.mode === "enforce"
                ? t("detail.hookEnforce")
                : t("detail.hookObserve")}
            </Sub>
          </span>
        ),
      testId: "fact-hook-binary",
    },
    {
      term: t("detail.facts.hooksWritten"),
      value: (
        <>
          <NotBacked gap="hooks" />
          <Sub>{t("detail.hooksWrittenBasis")}</Sub>
          <Sub>{t(`hooksReport.${hooksReportKey(host.hooksOk)}`)}</Sub>
        </>
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
                : t("detail.modelDirect")}
            </Sub>
          )}
        </>
      ),
      testId: "fact-model-surface",
    },
    {
      term: t("detail.facts.settings"),
      value: <NotBacked gap="hooks" />,
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
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("detail.subtitle", {
            platform: t(`platform.${host.platform}`),
            osUser: host.osUser,
          })}
        </p>
      }
      aside={<HealthBadge health={healthOf(host, now)} />}
    >
      <div className={panelBody}>
        <Facts rows={facts} />
      </div>
    </Panel>
  );
}

function AgentRow({
  agent,
  agentKey,
  org,
  ws,
}: {
  agent: RuntimeAgent | null;
  agentKey: string;
  org: string;
  ws: string;
}) {
  const t = useTranslations("runtimes");
  const locale = useLocale();
  const card = (
    <AgentCard
      agentKey={agentKey}
      notRecorded={t("notRecorded")}
      sub={agent === null ? t("detail.agents.unknown") : agent.name}
    />
  );
  return (
    <tr data-testid="runtime-agent-row">
      <td className={cell}>
        {agent === null ? (
          card
        ) : (
          <SafeLink
            to={routes.agent(org, ws, agent.slug)}
            className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
          >
            {card}
          </SafeLink>
        )}
      </td>
      <td className={cell}>
        {agent === null || agent.operatorId === null ? (
          <span className="text-muted-foreground">{t("notRecorded")}</span>
        ) : (
          <OperatorName
            operator={{ id: agent.operatorId, name: null, kind: null }}
          >
            <span className={mono}>{agent.operatorId}</span>
          </OperatorName>
        )}
      </td>
      <td className={cell}>
        <NotBacked gap="tier" />
      </td>
      <td className={cell}>
        {agent === null || agent.principalId === null ? (
          <span className="text-muted-foreground">{t("notRecorded")}</span>
        ) : (
          <span className={`${mono} text-xs`}>{agent.principalId}</span>
        )}
      </td>
      <td className={numericCell}>
        {agent === null ? (
          <span className="text-muted-foreground">{t("notRecorded")}</span>
        ) : (
          formatCount(agent.runs30d, locale)
        )}
      </td>
    </tr>
  );
}

function AgentsPanel({
  host,
  agents,
  org,
  ws,
}: {
  host: RuntimeEnrollment;
  agents: Read<RuntimeAgents>;
  org: string;
  ws: string;
}) {
  const t = useTranslations("runtimes.detail.agents");
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
          <Table
            label={t("title")}
            columns={[
              { label: t("columns.agent") },
              { label: t("columns.operator") },
              { label: t("columns.tier") },
              { label: t("columns.principal") },
              { label: t("columns.runs"), numeric: true },
            ]}
          >
            <AgentRow
              agent={agent}
              agentKey={host.agentKey}
              org={org}
              ws={ws}
            />
          </Table>
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
  now,
}: {
  host: RuntimeEnrollment;
  agent: string;
  org: string;
  ws: string;
  now: number;
}) {
  const t = useTranslations("runtimes.detail.rollback");
  const code = (chunks: ReactNode) => <code className={mono}>{chunks}</code>;
  const revoked = healthOf(host, now) === "revoked";
  return (
    <Panel id="runtime-rollback" title={t("title")}>
      <div className={`${panelBody} flex flex-col gap-3`}>
        <pre
          data-testid="runtime-unenroll-command"
          className={`${mono} overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted px-3.5 py-3 text-xs`}
        >
          {t("command", { agent, id: host.id })}
        </pre>
        <p className="border-l-2 border-accent-text pl-3 text-[13px] text-muted-foreground">
          {t.rich("note", { code })}
        </p>
        <div className="flex flex-wrap gap-2">
          <SmokeSession hostname={host.hostname} />
          {revoked ? null : (
            <Unenroll
              org={org}
              ws={ws}
              runtimeId={host.id}
              hostname={host.hostname}
              agent={host.agentKey}
            />
          )}
        </div>
      </div>
    </Panel>
  );
}

/** The loaded detail, below the page header. */
export function RuntimeLoaded({
  host,
  agents,
  org,
  ws,
  wsName,
  now,
}: {
  host: RuntimeEnrollment;
  agents: Read<RuntimeAgents>;
  org: string;
  ws: string;
  wsName: string;
  now: number;
}) {
  const t = useTranslations("runtimes.detail");
  const agent = agents.ok
    ? agents.value.agents.find((a) => a.agentKey === host.agentKey)
    : undefined;
  return (
    <>
      <div>
        <SafeLink
          to={routes.runtimes(org, ws)}
          data-testid="runtime-back"
          data-touch-target=""
          className={`${buttonSecondary} min-h-7 px-2.5 text-xs`}
        >
          {t("back")}
        </SafeLink>
      </div>
      <div className="flex flex-col gap-3.5">
        <HostPanel host={host} wsName={wsName} now={now} />
        <AgentsPanel host={host} agents={agents} org={org} ws={ws} />
        <RollbackPanel
          host={host}
          agent={
            agent?.slug ?? (host.agentKey.split(".").at(-1) || host.agentKey)
          }
          org={org}
          ws={ws}
          now={now}
        />
      </div>
    </>
  );
}

async function readRuntime(ctx: WsCtx, source: DataSource, runtime: string) {
  const list = await source.runtimes.list(ctx);
  if (!list.ok)
    return { state: "failed" as const, read: list, now: Date.now() };
  const host = list.value.enrollments.find((row) => row.id === runtime);
  if (host === undefined) return { state: "missing" as const, now: Date.now() };
  const agents: Read<RuntimeAgents> =
    host.agentKey === ""
      ? { ok: true, value: { agents: [] } }
      : await source.runtimes.agents(ctx, [host.agentKey]);
  return { state: "found" as const, host, agents, now: Date.now() };
}

export async function Runtime({
  ctx,
  source,
  org,
  ws,
  runtime,
}: {
  ctx: WsCtx;
  source: DataSource;
  org: string;
  ws: string;
  runtime: string;
}) {
  const read = await readRuntime(ctx, source, runtime);
  if (read.state === "failed")
    return (
      <RuntimesFailure
        read={read.read}
        org={org}
        ws={ws}
        orgName={ctx.orgName}
        wsSlug={ctx.wsSlug}
        orgRole={ctx.orgRole}
        wsRole={ctx.wsRole}
        readAt={new Date(read.now).toISOString()}
      />
    );
  if (read.state === "missing") notFound();
  return (
    <>
      <RuntimesHeader org={org} ws={ws} wsName={ctx.wsName} />
      <RuntimeLoaded
        host={read.host}
        agents={read.agents}
        org={org}
        ws={ws}
        wsName={ctx.wsName}
        now={read.now}
      />
    </>
  );
}
