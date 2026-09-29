// entry.ts: where discovery starts, where a person reads its progress, and
// where the durable functions run it (lane M10, #4682; mcp-studio-spec, Sync).
//
// - Studio (lane M9) calls startServerDiscovery, readServerDiscovery,
//   listServerDiscoveries, and readServerTools. Each checks the caller's role
//   first.
// - The gateway (lane M15) calls requestDiscovery on a server's
//   notifications/tools/list_changed, and the catalog sync calls it when a
//   registry publishes a newer version. It checks no role: the caller is the
//   platform, not a person.
// - The push webhooks call requestDiscoveries through ./webhook.
// - The Inngest runner that register.ts installs calls runDiscoveryEvent and
//   planDiscoverySweep.
//
// Each request marks the server queued and sends one
// `mcp-server/discover.requested` event. The discover function runs one
// discovery at a time per server, keyed by discoveryKey.
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { serverNameSchema } from "@oxagen/mcp-studio";
import { HandlerError } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eventClient } from "../../event-client";
import {
  postgresDiscoveryStore,
  postgresDiscoverySweepStore,
  postgresDiscoveryToolsStore,
  readWithheldTools,
  type DiscoveryRow,
  type DiscoveryStore,
  type DiscoverySweepStore,
  type DiscoveryTarget,
  type DiscoveryToolsStore,
  type StoredTool,
} from "./store";
import { runDiscovery, type RunDiscoveryDeps } from "./sync";
import {
  discoveryKey,
  type DiscoveryEventData,
  type DiscoveryResult,
  type DiscoveryScope,
  type DiscoveryTrigger,
} from "./types";

export { readWithheldTools };
export type { DiscoveryRow, DiscoveryResult, DiscoveryTrigger };

/** The event the discover function subscribes to. */
export const DISCOVERY_EVENT = "mcp-server/discover.requested";

/** One request for a discovery, as the event client sends it. */
export type DiscoveryRequestEvent = {
  name: typeof DISCOVERY_EVENT;
  data: DiscoveryEventData;
  /** Set by the sweep, so a second sweep in the same hour sends nothing new. */
  id?: string;
};

export type DiscoverySender = (
  events: DiscoveryRequestEvent[],
) => Promise<void>;

/** Who is asking, as a capability context carries it. */
export interface DiscoveryActor extends DiscoveryScope {
  userId: string | null;
  apiKeyId: string | null;
}

export interface DiscoveryEntryDeps {
  store?: DiscoveryStore;
  sweep?: DiscoverySweepStore;
  tools?: DiscoveryToolsStore;
  send?: DiscoverySender;
  now?: () => Date;
}

/** The roles that may ask for a discovery: the ones that may edit tools. */
const START_ROLES = {
  org: ["Owner", "Admin"],
  workspace: ["Owner", "Member"],
} as const;

/** The roles that may read discovery state. */
const READ_ROLES = {
  org: ["Owner", "Admin"],
  workspace: ["Owner", "Member", "Viewer"],
} as const;

/** The most servers one sweep asks for, per kind of work. */
export const SWEEP_LIMIT = 200;

/** A daily server is due once its last discovery is this old. */
export const DAILY_MS = 24 * 60 * 60 * 1000;

/**
 * A discovery queued or running this long has stalled. A run times out
 * after 10 minutes and retries twice, so a live run never gets this old.
 */
export const STALLED_MS = 60 * 60 * 1000;

const sendEvents: DiscoverySender = async (events) => {
  if (events.length === 0) return;
  await eventClient.send(
    events.map((event) => ({
      name: event.name,
      data: event.data,
      ...(event.id === undefined ? {} : { id: event.id }),
    })),
  );
};

function requestEvent(
  target: DiscoveryTarget,
  trigger: DiscoveryTrigger,
  requestedBy: string | null,
  id?: string,
): DiscoveryRequestEvent {
  const { scope, server } = target;
  return {
    name: "mcp-server/discover.requested",
    data: {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      server,
      trigger,
      key: discoveryKey(scope, server),
      ...(requestedBy === null ? {} : { requestedBy }),
    },
    ...(id === undefined ? {} : { id }),
  };
}

/** Refuse a name that cannot be a folder under tools/servers/. */
function serverName(server: string): string {
  if (!serverNameSchema.safeParse(server).success)
    throw new HandlerError({
      code: "not_found",
      reason: "mcp_server_not_found",
      message: `No MCP server is named ${JSON.stringify(server)}.`,
    });
  return server;
}

/**
 * Mark each target queued and send its event. The platform asks through this
 * with no role check.
 */
export async function requestDiscoveries(
  targets: readonly DiscoveryTarget[],
  trigger: DiscoveryTrigger,
  deps: DiscoveryEntryDeps = {},
  requestedBy: string | null = null,
): Promise<number> {
  const store = deps.store ?? postgresDiscoveryStore;
  const send = deps.send ?? sendEvents;
  const now = deps.now ?? (() => new Date());
  const events: DiscoveryRequestEvent[] = [];
  for (const target of targets) {
    serverName(target.server);
    const { scope, server } = target;
    await store.request(scope, server, trigger, requestedBy, now());
    events.push(requestEvent(target, trigger, requestedBy));
  }
  await send(events);
  return events.length;
}

/**
 * Ask for one server's discovery on the platform's behalf: a list_changed
 * notification, a newer registry version, or a push. It checks no role.
 */
export async function requestDiscovery(
  scope: DiscoveryScope,
  server: string,
  trigger: Exclude<DiscoveryTrigger, "manual">,
  deps: DiscoveryEntryDeps = {},
): Promise<void> {
  await requestDiscoveries([{ scope, server }], trigger, deps);
}

/**
 * A person asks Studio to discover one server's tools now. The run ignores
 * the server's sync.schedule. Returns the queued row.
 */
export async function startServerDiscovery(
  actor: DiscoveryActor,
  server: string,
  deps: DiscoveryEntryDeps = {},
): Promise<DiscoveryRow | null> {
  const scope = { orgId: actor.orgId, workspaceId: actor.workspaceId };
  const store = deps.store ?? postgresDiscoveryStore;
  const userId = await runInTenantScope(scope, async () => {
    const acting = await resolveActingUserId({
      orgId: actor.orgId,
      userId: actor.userId,
      apiKeyId: actor.apiKeyId,
    });
    await assertOrgRole(
      { orgId: actor.orgId, workspaceId: actor.workspaceId, userId: acting },
      START_ROLES,
    );
    return acting;
  });
  await requestDiscoveries(
    [{ scope, server: serverName(server) }],
    "manual",
    deps,
    userId,
  );
  return store.read(scope, server);
}

async function assertReader(actor: DiscoveryActor): Promise<DiscoveryScope> {
  const scope = { orgId: actor.orgId, workspaceId: actor.workspaceId };
  await runInTenantScope(scope, async () => {
    const userId = await resolveActingUserId({
      orgId: actor.orgId,
      userId: actor.userId,
      apiKeyId: actor.apiKeyId,
    });
    await assertOrgRole(
      { orgId: actor.orgId, workspaceId: actor.workspaceId, userId },
      READ_ROLES,
    );
  });
  return scope;
}

/**
 * One server's discovery state: status, outcome, tool count, the open sync
 * steering PR, and the withheld tools. Null when it was never discovered.
 */
export async function readServerDiscovery(
  actor: DiscoveryActor,
  server: string,
  deps: DiscoveryEntryDeps = {},
): Promise<DiscoveryRow | null> {
  const scope = await assertReader(actor);
  return (deps.store ?? postgresDiscoveryStore).read(scope, serverName(server));
}

/** Every discovered server in the workspace, by name. */
export async function listServerDiscoveries(
  actor: DiscoveryActor,
  deps: DiscoveryEntryDeps = {},
): Promise<DiscoveryRow[]> {
  const scope = await assertReader(actor);
  return (deps.store ?? postgresDiscoveryStore).list(scope);
}

/** One tool a server offers now, as Studio's Tools tab shows it. */
export interface ServerTool {
  /** The upstream name, as the source offers it. */
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  /** The MCP hints, or null when the source gives none. */
  annotations: Record<string, unknown> | null;
  /** The mcp.tool_snapshots row this tool reads from. */
  snapshotId: string;
  capturedAt: Date;
  /** True while the gateway hides the tool until the sync steering PR merges. */
  withheld: boolean;
}

/** A server's current tools, from its newest snapshots. */
export interface ServerTools {
  server: string;
  /** The newest snapshot row among the tools, or null with no tools. */
  snapshotId: string | null;
  /** When that row was written, or null with no tools. */
  capturedAt: Date | null;
  /** By name. Empty before the first discovery reads the source. */
  tools: ServerTool[];
}

/**
 * The tools a server's last discovery read, each from its newest snapshot,
 * with the ones the gateway withholds marked. A server with no snapshot yet
 * returns no tools, not an error.
 */
export async function readServerTools(
  actor: DiscoveryActor,
  server: string,
  deps: DiscoveryEntryDeps = {},
): Promise<ServerTools> {
  const scope = await assertReader(actor);
  const name = serverName(server);
  const read = await (deps.tools ?? postgresDiscoveryToolsStore).read(
    scope,
    name,
  );
  const held = new Set(read.withheldUpstream);
  let newest: StoredTool | null = null;
  for (const tool of read.tools) {
    if (newest === null || tool.capturedAt > newest.capturedAt) newest = tool;
  }
  return {
    server: name,
    snapshotId: newest?.snapshotId ?? null,
    capturedAt: newest?.capturedAt ?? null,
    tools: read.tools.map((tool) => ({ ...tool, withheld: held.has(tool.name) })),
  };
}

const TRIGGERS: ReadonlySet<string> = new Set(schema.MCP_DISCOVERY_TRIGGERS);

function isTrigger(value: string): value is DiscoveryTrigger {
  return TRIGGERS.has(value);
}

/** The event data the discover function hands the runner. */
export type DiscoveryRunData = {
  orgId: string;
  workspaceId: string;
  server: string;
  trigger: string;
  requestedBy?: string | undefined;
};

/** Run one discovery for the durable function, in the workspace's scope. */
export async function runDiscoveryEvent(
  data: DiscoveryRunData,
  deps: RunDiscoveryDeps = {},
): Promise<DiscoveryResult> {
  // A malformed event fails the same way on every retry, so the durable
  // function stops at once.
  const malformed = (message: string) =>
    Object.assign(new Error(message), { isNonRetriable: true });
  if (!isTrigger(data.trigger))
    throw malformed(
      `Unknown discovery trigger ${JSON.stringify(data.trigger)}.`,
    );
  if (!serverNameSchema.safeParse(data.server).success)
    throw malformed(`No MCP server is named ${JSON.stringify(data.server)}.`);
  const scope = { orgId: data.orgId, workspaceId: data.workspaceId };
  const trigger = data.trigger;
  return runInTenantScope(scope, () =>
    runDiscovery(
      {
        scope,
        server: data.server,
        trigger,
        requestedBy: data.requestedBy,
      },
      deps,
    ),
  );
}

/**
 * The events the hourly sweep sends:
 *
 * - schedule, for every published server with no discovery yet;
 * - schedule, for every daily server whose last discovery is a day old;
 * - lock_merged, for every server with an open sync steering PR, so a merge
 *   releases the withheld tools and a closed PR is let go;
 * - the row's own trigger, for every discovery queued or running for an
 *   hour, so a lost event or a dead worker does not strand the request;
 * - registry_version, for every on-change or daily registry server whose
 *   synced catalog lists a version discovery has not seen. The sweep runs
 *   hourly and catalog sync every six hours, so a new version is asked for
 *   within the catalog cycle that brought it.
 *
 * A server that already has a schedule event this hour gets no
 * registry_version event, because a scheduled discovery reads the registry's
 * newest version too. Each event carries an id for the hour, so a sweep that
 * runs twice in one hour sends each event once.
 */
export async function planDiscoverySweep(
  now: Date,
  deps: Pick<DiscoveryEntryDeps, "sweep"> = {},
): Promise<DiscoveryRequestEvent[]> {
  const sweep = deps.sweep ?? postgresDiscoverySweepStore;
  const [fresh, due, open, stalled, moved] = await Promise.all([
    sweep.undiscovered(SWEEP_LIMIT),
    sweep.dueDaily(new Date(now.getTime() - DAILY_MS), SWEEP_LIMIT),
    sweep.openPullRequests(SWEEP_LIMIT),
    sweep.stalled(new Date(now.getTime() - STALLED_MS), SWEEP_LIMIT),
    sweep.registryMoved(SWEEP_LIMIT),
  ]);
  const hour = now.toISOString().slice(0, 13);
  const events = new Map<string, DiscoveryRequestEvent>();
  const scheduled = new Set<string>();
  const add = (targets: DiscoveryTarget[], trigger: DiscoveryTrigger) => {
    for (const target of targets) {
      if (!serverNameSchema.safeParse(target.server).success) continue;
      const key = discoveryKey(target.scope, target.server);
      if (trigger === "schedule") scheduled.add(key);
      if (trigger === "registry_version" && scheduled.has(key)) continue;
      const id = `mcp-discovery:${trigger}:${key}:${hour}`;
      if (!events.has(id))
        events.set(id, requestEvent(target, trigger, null, id));
    }
  };
  add(fresh, "schedule");
  add(due, "schedule");
  add(open, "lock_merged");
  for (const target of stalled) add([target], target.trigger);
  add(moved, "registry_version");
  return [...events.values()];
}
