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
// The table carries the design's list controls (`ListTable`): search, the
// filters its rule offers, Rows, and the pager.
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
import { type ListRow, ListTable } from "@/ui/list-table";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { PageHeader } from "@/ui/page-header";
import { EnrollRuntime } from "./controls";
import {
  HarnessNames,
  HealthBadge,
  isEnrolled,
  ModelSurface,
  NotBacked,
  Note,
  OsLine,
  Panel,
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

/**
 * Agents on a host that is still enrolled: distinct keys, a revoked or an
 * expired enrollment excluded. It is the rule the Health cell reads, so the
 * tile never counts an agent on a row the table calls not enrolled.
 */
function hostedAgents(list: RuntimeList, now: number): number {
  const keys = new Set<string>();
  for (const host of list.enrollments)
    if (isEnrolled(host, now) && host.agentKey !== "") keys.add(host.agentKey);
  return keys.size;
}

function StatStrip({ list, now }: { list: RuntimeList; now: number }) {
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
        value={formatCount(hostedAgents(list, now), locale)}
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

/** The Runtime cell: the name, which opens the runtime, with the OS in mono under it. */
function RuntimeName({
  host,
  org,
  ws,
}: {
  host: RuntimeEnrollment;
  org: string;
  ws: string;
}) {
  const t = useTranslations("runtimes.hosts");
  return (
    <>
      <SafeLink
        to={routes.runtime(org, ws, host.id)}
        aria-label={t("open", { hostname: host.hostname })}
        data-touch-target=""
        className="inline-flex items-center rounded-sm font-medium after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-ring"
      >
        {host.hostname}
      </SafeLink>
      <Sub monoFace>
        <OsLine host={host} />
      </Sub>
    </>
  );
}

/** The Agents cell (`td.num`): the count right-aligned, its sub-line under it. */
function AgentsCell({ host }: { host: RuntimeEnrollment }) {
  const t = useTranslations("runtimes.hosts");
  return host.agentKey === "" ? (
    <>
      <span className="text-muted-foreground">0</span>
      <Sub>{t("agentsNone")}</Sub>
    </>
  ) : (
    <>
      1<Sub monoFace>{host.agentKey}</Sub>
    </>
  );
}

function CollectorCell({ host }: { host: RuntimeEnrollment }) {
  const t = useTranslations("runtimes");
  return (
    <>
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
    </>
  );
}

/** One enrollment as a list row, in the spec's column order. */
function hostRow(
  host: RuntimeEnrollment,
  org: string,
  ws: string,
  now: number,
  hookCount: ReactNode,
): ListRow {
  return {
    key: host.id,
    data: { "data-testid": "runtime-row", "data-runtime": host.id },
    className: "relative cursor-pointer",
    cells: [
      <RuntimeName key="runtime" host={host} org={org} ws={ws} />,
      <NotBacked key="kind" gap="host" />,
      <HarnessNames key="harness" host={host} />,
      <ModelSurface key="model" host={host} />,
      <NotBacked key="tier" gap="tier" />,
      <AgentsCell key="agents" host={host} />,
      <CollectorCell key="collector" host={host} />,
      <NotBacked key="hooks" gap="hooks">
        {hookCount}
      </NotBacked>,
      <HealthBadge key="health" host={host} now={now} />,
      <NotBacked key="checkpoint" gap="checkpoint" />,
    ],
  };
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
      // The design badges the runtime count. The record holds enrollments,
      // not hosts (#3816), so the badge is not recorded, as the tile is.
      count={<NotBacked gap="host" />}
    >
      <ListTable
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
        rows={list.enrollments.map((host) =>
          hostRow(host, org, ws, now, t("hookCount")),
        )}
      />
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
      <StatStrip list={list} now={now} />
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
