// The Runtimes page (roadmap mockups/pages/runtimes.md, mockup `pRuntimes()`):
// the hosts agents run on, and what each host's seam earns.
//
// What the record carries today is an enrollment per agent
// (`list_tacho_hosts`): one agent key on one machine. The page lists those rows
// rather than grouping them by hostname into a host the record does not hold.
// Every element the spec draws from a host row that does not exist (the kind,
// the tier rolled up per host, the telemetry gaps in 24 hours and the health
// judged from them, the hooks written, the last checkpoint, and the counts
// over hosts) renders as not recorded, carrying the gap that would record it.
// A row opens the runtime: the hostname is the link, stretched over the row.
//
// States: the route's loading.tsx replaces the body while the read is in
// flight; a refused or failed read replaces the body, header included; a
// workspace with no enrollment keeps the header and shows the empty state.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RuntimeEnrollment, RuntimeList } from "@/data/contracts/runtimes";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { mono, panelBody, statStrip } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { PageHeader } from "@/ui/page-header";
import { cell, numericCell, Table } from "@/ui/table";
import { EnrollRuntime } from "./controls";
import {
  HarnessNames,
  HealthBadge,
  ModelSurface,
  NotBacked,
  Note,
  Panel,
  PlatformName,
  Sub,
  TierLadder,
  Tile,
} from "./parts";
import { RuntimesEmpty, RuntimesFailure } from "./states";

/** The page header: the workspace as the eyebrow, the h1, the one sentence, and Enroll a runtime. */
export function RuntimesHeader({
  org,
  ws,
  wsName,
  gold = true,
}: {
  org: string;
  ws: string;
  wsName: string;
  /** False where the body already carries the screen's one gold action. */
  gold?: boolean;
}) {
  const t = useTranslations();
  return (
    <PageHeader
      eyebrow={t("runtimes.page.eyebrow", { workspace: wsName })}
      title={t("pages.runtimes")}
      description={t("runtimes.page.description")}
      actions={<EnrollRuntime org={org} ws={ws} gold={gold} />}
    />
  );
}

/** Agents with a live enrollment in the workspace: distinct keys, a revoked enrollment excluded. */
function hostedAgents(list: RuntimeList): number {
  const keys = new Set<string>();
  for (const host of list.enrollments)
    if (host.status !== "revoked" && host.agentKey !== "")
      keys.add(host.agentKey);
  return keys.size;
}

function StatStrip({ list }: { list: RuntimeList }) {
  const t = useTranslations("runtimes.tiles");
  const locale = useLocale();
  return (
    <div className={statStrip} data-testid="runtimes-tiles">
      <Tile
        testId="tile-runtimes"
        term={t("runtimes")}
        value={<NotBacked gap="host" />}
        basis={t("runtimesBasis", { count: list.enrollments.length })}
      />
      <Tile
        testId="tile-agents"
        term={t("agentsHosted")}
        value={formatCount(hostedAgents(list), locale)}
        basis={t("agentsHostedBasis")}
      />
      <Tile
        testId="tile-tier"
        term={t("highestTier")}
        value={<NotBacked gap="tier" />}
        basis={t("highestTierBasis")}
      />
      <Tile
        testId="tile-degraded"
        term={t("degraded")}
        value={<NotBacked gap="gaps" />}
        basis={t("degradedBasis")}
      />
    </div>
  );
}

function HostRow({
  host,
  org,
  ws,
  now,
}: {
  host: RuntimeEnrollment;
  org: string;
  ws: string;
  now: number;
}) {
  const t = useTranslations("runtimes");
  return (
    <tr
      data-testid="runtime-row"
      data-runtime={host.id}
      className="relative cursor-pointer"
    >
      <td className={cell}>
        <SafeLink
          to={routes.runtime(org, ws, host.id)}
          aria-label={t("hosts.open", { hostname: host.hostname })}
          data-touch-target=""
          className="inline-flex items-center rounded-sm font-medium after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-ring"
        >
          {host.hostname}
        </SafeLink>
        <Sub monoFace>
          <PlatformName platform={host.platform} />
        </Sub>
      </td>
      <td className={cell}>
        <NotBacked gap="host" />
      </td>
      <td className={cell}>
        <HarnessNames host={host} />
      </td>
      <td className={cell}>
        <ModelSurface host={host} />
      </td>
      <td className={cell}>
        <NotBacked gap="tier" />
      </td>
      {/* `td.num`: the count right-aligned, its sub-line under it. */}
      <td className={numericCell} data-testid="runtime-agents">
        {host.agentKey === "" ? (
          <>
            <span className="text-muted-foreground">0</span>
            <Sub>{t("hosts.agentsNone")}</Sub>
          </>
        ) : (
          <>
            1<Sub monoFace>{host.agentKey}</Sub>
          </>
        )}
      </td>
      <td className={cell}>
        {host.collectorVersion === null ? (
          <span className="text-muted-foreground">{t("notReported")}</span>
        ) : (
          <span className={`${mono} text-xs`}>
            {t("hosts.collector", { version: host.collectorVersion })}
          </span>
        )}
        <Sub>
          <NotBacked gap="gaps">{t("hosts.gaps")}</NotBacked>
        </Sub>
      </td>
      <td className={numericCell} data-testid="runtime-hooks">
        <NotBacked gap="hooks">{t("hosts.hookCount")}</NotBacked>
      </td>
      <td className={cell}>
        <HealthBadge host={host} now={now} />
      </td>
      <td className={cell}>
        <NotBacked gap="checkpoint" />
      </td>
    </tr>
  );
}

function EnrolledHosts({
  list,
  org,
  ws,
  now,
}: {
  list: RuntimeList;
  org: string;
  ws: string;
  now: number;
}) {
  const t = useTranslations("runtimes.hosts");
  const locale = useLocale();
  return (
    <Panel
      id="runtimes-hosts"
      title={t("title")}
      count={list.enrollments.length}
    >
      <Table
        label={t("title")}
        columns={[
          { label: t("columns.runtime") },
          { label: t("columns.kind") },
          { label: t("columns.harness") },
          { label: t("columns.modelSurface") },
          { label: t("columns.tier") },
          { label: t("columns.agents"), numeric: true },
          { label: t("columns.collector") },
          { label: t("columns.hooks"), numeric: true },
          { label: t("columns.health") },
          { label: t("columns.checkpoint") },
        ]}
      >
        {list.enrollments.map((host) => (
          <HostRow key={host.id} host={host} org={org} ws={ws} now={now} />
        ))}
      </Table>
      {list.more ? (
        <p
          data-testid="runtimes-more"
          className={`${panelBody} text-xs text-muted-foreground`}
        >
          {t("more", {
            count: formatCount(list.enrollments.length, locale),
          })}
        </p>
      ) : null}
      <Note>{t("note")}</Note>
    </Panel>
  );
}

function Ladder() {
  const t = useTranslations("runtimes.ladder");
  const code = (chunks: ReactNode) => <code className={mono}>{chunks}</code>;
  return (
    <Panel id="runtimes-ladder" title={t("title")}>
      <div className={panelBody}>
        <TierLadder />
      </div>
      <Note>{t.rich("note", { code })}</Note>
    </Panel>
  );
}

/** The loaded list, below its header. */
function RuntimesLoaded({
  list,
  org,
  ws,
  now,
}: {
  list: RuntimeList;
  org: string;
  ws: string;
  now: number;
}) {
  return (
    <>
      <StatStrip list={list} />
      <EnrolledHosts list={list} org={org} ws={ws} now={now} />
      <Ladder />
    </>
  );
}

async function readRuntimes(ctx: WsCtx, source: DataSource) {
  const read = await source.runtimes.list(ctx);
  return { read, now: Date.now() };
}

export async function Runtimes({
  ctx,
  source,
  org,
  ws,
  viewerName,
}: {
  ctx: WsCtx;
  source: DataSource;
  org: string;
  ws: string;
  /** The signed-in person's name or email, for the access-denied state. */
  viewerName: string;
}) {
  const { read, now } = await readRuntimes(ctx, source);
  if (!read.ok)
    return (
      <RuntimesFailure
        read={read}
        org={org}
        ws={ws}
        orgName={ctx.orgName}
        wsSlug={ctx.wsSlug}
        wsRole={ctx.wsRole}
        viewerName={viewerName}
        readAt={now}
      />
    );
  if (read.value.enrollments.length === 0)
    return (
      <>
        <RuntimesHeader org={org} ws={ws} wsName={ctx.wsName} gold={false} />
        <RuntimesEmpty org={org} ws={ws} />
      </>
    );
  return (
    <>
      <RuntimesHeader org={org} ws={ws} wsName={ctx.wsName} />
      <RuntimesLoaded list={read.value} org={org} ws={ws} now={now} />
    </>
  );
}
