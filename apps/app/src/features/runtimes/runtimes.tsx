// The Runtimes tab of the Agents page (roadmap mockups `agtRuntimesTab()`):
// where agents run, in one table with the design's five columns: Runtime,
// Kind, Health, Agents and Last seen. A row opens the runtime in the drawer
// over the tab (`routes.runtime`); the name is the link, stretched over the
// row. The Agents page draws the one header and the tab strip.
//
// The record holds two kinds of row, and the table lists both. The runtimes
// the workspace named (`list_runtimes`, ADR-198) come first, each with its
// agents by harness and Register an agent while it has none. The host
// enrollments (`list_tacho_hosts`) follow: one agent key on one machine. The
// record has no link from an enrollment to the runtime it enrolled against,
// so the table does not fold one into the other.
//
// Kind is not recorded (#3816). Health reads what the record backs: an
// enrollment revoked or past its expiry is not enrolled, a runtime unseen for
// a day is offline (roadmap README, Offline runtime), and a host whose hooks
// the collector read back incomplete says so. Healthy is judged from the
// collector's telemetry gaps, which nothing records (#3818), so a runtime
// seen within the day has no health word.
//
// States: the tab's skeleton replaces the body while the reads run; a refused
// or failed host read replaces the body, and the header and strip stay; a
// workspace with nothing named and nothing enrolled shows the empty state.
import { useLocale, useTranslations } from "next-intl";
import type {
  NamedRuntime,
  NamedRuntimeList,
  RuntimeEnrollment,
  RuntimeList,
} from "@/data/contracts/runtimes";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { AgentAvatar } from "@/ui/agent-avatar";
import { Badge } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { type ListRow, ListTable } from "@/ui/list-table";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { AddRuntime, RegisterOnRuntime } from "./controls";
import { AgentsCell, LastSeen } from "./named";
import { HealthBadge, isEnrolled, NotBacked, OsLine, Sub } from "./parts";
import { RuntimesEmpty, RuntimesFailure } from "./states";

/** The org roles that may name a runtime and register its agents (INV-29). */
export function mayAddRuntime(ctx: WsCtx): boolean {
  return ctx.orgRole === "owner" || ctx.orgRole === "admin";
}

/** A day, after which a runtime that has not reported reads offline. */
const OFFLINE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a runtime has reported within the day: `unseen` before its first
 * report, `offline` a day after its last, and `seen` otherwise.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function seenState(
  lastSeenAt: string | null,
  now: number,
): "unseen" | "offline" | "seen" {
  if (lastSeenAt === null) return "unseen";
  return now - Date.parse(lastSeenAt) >= OFFLINE_AFTER_MS ? "offline" : "seen";
}

/** The health word the last report backs: offline, not seen yet, or not recorded (#3818). */
function SeenHealth({
  lastSeenAt,
  now,
}: {
  lastSeenAt: string | null;
  now: number;
}) {
  const t = useTranslations("runtimes.list.health");
  const seen = seenState(lastSeenAt, now);
  if (seen === "offline")
    return (
      <Badge tone="failed" data-health="offline">
        {t("offline")}
      </Badge>
    );
  if (seen === "unseen")
    return (
      <Badge tone="quiet" data-health="unseen">
        {t("unseen")}
      </Badge>
    );
  return (
    <span data-health="not_recorded">
      <NotBacked gap="gaps" />
    </span>
  );
}

function HostHealth({
  host,
  now,
}: {
  host: RuntimeEnrollment;
  now: number;
}) {
  const t = useTranslations("runtimes.list.health");
  if (!isEnrolled(host, now)) return <HealthBadge host={host} now={now} />;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <SeenHealth lastSeenAt={host.lastSeenAt} now={now} />
      {host.hooksOk === false ? (
        <Badge tone="approval" data-health="hooks">
          {t("hooksIncomplete")}
        </Badge>
      ) : null}
    </span>
  );
}

function NamedHealth({
  runtime,
  now,
}: {
  runtime: NamedRuntime;
  now: number;
}) {
  const t = useTranslations("runtimes.list.health");
  if (runtime.liveHosts === 0)
    return (
      <Badge tone="quiet" data-health="no_host">
        {t("noHost")}
      </Badge>
    );
  return <SeenHealth lastSeenAt={runtime.lastSeenAt} now={now} />;
}

/** The Runtime cell's link: the name, which opens the drawer, stretched over the row. */
function RuntimeLink({
  id,
  name,
  org,
  ws,
}: {
  id: string;
  name: string;
  org: string;
  ws: string;
}) {
  const t = useTranslations("runtimes.list");
  return (
    <SafeLink
      to={routes.runtime(org, ws, id)}
      aria-label={t("open", { runtime: name })}
      data-touch-target=""
      className="inline-flex max-w-full items-center rounded-sm font-medium after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="min-w-0 md:truncate">{name}</span>
    </SafeLink>
  );
}

function NamedHosts({ count }: { count: number }) {
  const t = useTranslations("runtimes.list");
  return <Sub>{count === 0 ? t("hostsNone") : t("hosts", { count })}</Sub>;
}

/**
 * The agent on a host row, its avatar badged with the harness it runs in. An
 * enrollment is one agent on one machine, so when the daemon reported one
 * harness it is the agent's. A host that reported several names no badge
 * rather than guess among them.
 */
function HostAgent({ host }: { host: RuntimeEnrollment }) {
  const t = useTranslations("runtimes.named");
  if (host.agentKey === "")
    return <span className="text-muted-foreground">{t("noAgent")}</span>;
  const only = host.harnesses.length === 1 ? host.harnesses[0] : null;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <AgentAvatar
        value={null}
        initials={(host.agentKey.split(".").at(-1) ?? "")
          .slice(0, 2)
          .toUpperCase()}
        harness={only}
        size={24}
      />
      <span className={`${mono} block min-w-0 md:truncate`}>
        {host.agentKey}
      </span>
    </span>
  );
}

function namedRow(
  runtime: NamedRuntime,
  at: { org: string; ws: string; now: number; canRegister: boolean },
): ListRow {
  return {
    key: runtime.id,
    data: { "data-testid": "named-runtime", "data-runtime": runtime.id },
    className: "relative cursor-pointer",
    cells: [
      <span key="runtime">
        <RuntimeLink
          id={runtime.id}
          name={runtime.name}
          org={at.org}
          ws={at.ws}
        />
        <NamedHosts count={runtime.liveHosts} />
      </span>,
      <NotBacked key="kind" gap="host" />,
      <NamedHealth key="health" runtime={runtime} now={at.now} />,
      <span key="agents">
        <AgentsCell runtime={runtime} />
        {runtime.agents.length === 0 && at.canRegister ? (
          <span className="block pt-1">
            <RegisterOnRuntime
              org={at.org}
              ws={at.ws}
              runtimeId={runtime.id}
              runtimeName={runtime.name}
            />
          </span>
        ) : null}
      </span>,
      <LastSeen key="seen" at={runtime.lastSeenAt} />,
    ],
  };
}

function hostRow(
  host: RuntimeEnrollment,
  at: { org: string; ws: string; now: number },
): ListRow {
  return {
    key: host.id,
    data: { "data-testid": "runtime-row", "data-runtime": host.id },
    className: "relative cursor-pointer",
    cells: [
      <span key="runtime">
        <RuntimeLink
          id={host.id}
          name={host.hostname}
          org={at.org}
          ws={at.ws}
        />
        <Sub monoFace>
          <OsLine host={host} />
        </Sub>
      </span>,
      <NotBacked key="kind" gap="host" />,
      <HostHealth key="health" host={host} now={at.now} />,
      <HostAgent key="agents" host={host} />,
      <LastSeen key="seen" at={host.lastSeenAt} />,
    ],
  };
}

/** How many runtimes the table lists with no agent on them. */
function idleCount(
  named: readonly NamedRuntime[],
  hosts: readonly RuntimeEnrollment[],
): number {
  return (
    named.filter((runtime) => runtime.agents.length === 0).length +
    hosts.filter((host) => host.agentKey === "").length
  );
}

/** The loaded tab: the idle note and Add a runtime, then the table. */
function RuntimesLoaded({
  list,
  named,
  org,
  ws,
  now,
  canAdd,
}: {
  list: RuntimeList;
  named: Read<NamedRuntimeList>;
  org: string;
  ws: string;
  now: number;
  canAdd: boolean;
}) {
  const t = useTranslations("runtimes.list");
  const locale = useLocale();
  const runtimes = named.ok ? named.value.runtimes : [];
  const idle = idleCount(runtimes, list.enrollments);
  const at = { org, ws, now, canRegister: canAdd };
  return (
    <>
      {idle === 0 && !canAdd ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {idle === 0 ? null : (
            <p
              data-testid="runtimes-idle"
              className="text-xs text-muted-foreground"
            >
              {t("idle", { count: idle })}
            </p>
          )}
          {canAdd ? (
            <span className="ml-auto">
              <AddRuntime org={org} ws={ws} gold={false} />
            </span>
          ) : null}
        </div>
      )}
      {named.ok ? null : (
        <div data-testid="runtimes-named-failed">
          <ReadFailure read={named} section={t("title")} />
        </div>
      )}
      <ListTable
        label={t("title")}
        columns={[
          { label: t("columns.runtime") },
          { label: t("columns.kind") },
          { label: t("columns.health") },
          { label: t("columns.agents") },
          { label: t("columns.lastSeen") },
        ]}
        rows={[
          ...runtimes.map((runtime) => namedRow(runtime, at)),
          ...list.enrollments.map((host) => hostRow(host, at)),
        ]}
      />
      {list.more ? (
        <p
          data-testid="runtimes-more"
          className="text-xs text-muted-foreground"
        >
          {t("more", {
            count: formatCount(list.enrollments.length, locale),
          })}
        </p>
      ) : null}
    </>
  );
}

async function readRuntimes(ctx: WsCtx, source: DataSource) {
  const [read, named] = await Promise.all([
    source.runtimes.list(ctx),
    source.runtimes.named(ctx),
  ]);
  return { read, named, now: Date.now() };
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
  const { read, named, now } = await readRuntimes(ctx, source);
  const canAdd = mayAddRuntime(ctx);
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
  // Empty only when nothing is named and nothing is enrolled: a named runtime
  // with no host yet is listed, with its Register an agent action.
  const nothingNamed = named.ok && named.value.runtimes.length === 0;
  if (read.value.enrollments.length === 0 && nothingNamed)
    return <RuntimesEmpty org={org} ws={ws} canAdd={canAdd} />;
  return (
    <RuntimesLoaded
      list={read.value}
      named={named}
      org={org}
      ws={ws}
      now={now}
      canAdd={canAdd}
    />
  );
}

/**
 * How many runtimes the Runtimes tab lists: the named runtimes and the host
 * enrollments. Null when either read did not answer, so the strip prints no
 * figure rather than a partial one.
 */
export async function runtimesCount(
  ctx: WsCtx,
  source: DataSource,
): Promise<number | null> {
  const { read, named } = await readRuntimes(ctx, source);
  if (!read.ok || !named.ok) return null;
  return named.value.runtimes.length + read.value.enrollments.length;
}
