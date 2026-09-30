// store.ts: the Postgres side of discovery (lane M10, #4682).
//
// mcp.server_discoveries holds one row per workspace and server folder: the
// last discovery's state, the source fields the push webhook matches on, the
// open sync steering PR, the tools the gateway withholds until it merges, and
// the upstream names the last source read offered. The tools store joins
// those names to their newest mcp.tool_snapshots rows for Studio.
//
// The scoped store opens the workspace's tenant transaction and filters by
// the scope as well, so one missing policy still leaks no row. The sweep
// store reads across workspaces with withSystemDb, and each of its queries
// says why in a tenancy comment.
import { schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import { readLatestSnapshots } from "@oxagen/agent/runtime/mcp-snapshots";
import { canonicalDigest } from "@oxagen/mcp-studio";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  and,
  arrayOverlaps,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type {
  DiscoveryOutcome,
  DiscoveryScope,
  DiscoveryTrigger,
  SyncSchedule,
} from "./types";

type Row = typeof schema.mcpServerDiscoveries.$inferSelect;

export type DiscoveryStatus =
  | "queued"
  | "running"
  | "waiting_for_machine"
  | "succeeded"
  | "failed";

/** One server's discovery state. */
export interface DiscoveryRow {
  /**
   * The row's id. The upsert never sets it, so it stays the same across
   * every discovery of the server and serves as the discovery id.
   */
  id: string;
  server: string;
  mcpServerId: string | null;
  status: DiscoveryStatus;
  trigger: DiscoveryTrigger;
  requestedAt: Date;
  requestedBy: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  outcome: DiscoveryOutcome | null;
  toolCount: number | null;
  machine: string | null;
  sourceKind: string | null;
  sourceRepo: string | null;
  sourcePath: string | null;
  sourceRef: string | null;
  schedule: SyncSchedule | null;
  upstreamDigest: string | null;
  latestVersion: string | null;
  pr: { number: number; url: string; branch: string } | null;
  withheld: string[];
}

/** The source fields server.toml gives, which the push webhook matches on. */
export interface DiscoverySourceFields {
  kind: string;
  /** A definition's repository, lowercased: github.com/owner/name. */
  repo: string | null;
  path: string | null;
  ref: string | null;
  schedule: SyncSchedule;
  mcpServerId: string | null;
  /** A registry server's source.server, the name the catalog lists it by. */
  registryName: string | null;
  /** A registry server's source.version. */
  version: string | null;
}

/** A waiting discovery a polling machine's process claimed. */
export interface ClaimedDiscovery {
  server: string;
  trigger: DiscoveryTrigger;
  requestedBy: string | null;
}

/** The claim the MCP process makes for a machine that polls (#4772). */
export interface DiscoveryClaimStore {
  /**
   * Claim the workspace's oldest discovery that waits for a machine in one
   * of `groups`, and mark it queued for the calling process to run (#4772).
   * Null when none waits. The read locks the row and skips one another
   * transaction holds, so two processes never claim one discovery.
   */
  claimWaiting(
    scope: DiscoveryScope,
    groups: readonly string[],
    now: Date,
  ): Promise<ClaimedDiscovery | null>;
}

/**
 * What a finished discovery writes. waiting_for_machine is a run that stopped
 * for a machine to poll (#4772): it records the groups that may run it and
 * leaves finishedAt empty, so the server does not read as discovered.
 */
export interface DiscoveryFinish {
  status: "succeeded" | "failed" | "waiting_for_machine";
  /** server.toml's source.machines, for a waiting run. */
  machineGroups?: readonly string[];
  outcome: DiscoveryOutcome | null;
  error: string | null;
  toolCount: number | null;
  machine: string | null;
  upstreamDigest: string | null;
  latestVersion: string | null;
  pr: { number: number; url: string; branch: string } | null;
  withheld: string[];
  /**
   * The upstream names the source offered. Absent when the run never read
   * the source, so the row keeps the last read's names.
   */
  offered?: string[];
  /**
   * The upstream names behind withheld, as mcp.tool_snapshots names them.
   * Absent when the run did not compare the surface, so the row keeps them.
   */
  withheldUpstream?: string[];
}

/** One tool the source offered, as mcp.tool_snapshots stores it. */
export interface SnapshotDescriptor {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  /** The MCP hints, when the source gives them. */
  annotations?: Record<string, unknown>;
}

/** One tool from a server's newest snapshots. */
export interface StoredTool {
  /** The upstream name, as the source offered it. */
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown> | null;
  /** The mcp.tool_snapshots row. */
  snapshotId: string;
  capturedAt: Date;
}

/** The tools the last source read offered, and the ones withheld. */
export interface DiscoveryTools {
  /** Upstream names the gateway withholds until the sync steering PR merges. */
  withheldUpstream: string[];
  /** One entry per offered tool with a snapshot, by name. */
  tools: StoredTool[];
}

/** Reads a server's current tools for Studio. */
export interface DiscoveryToolsStore {
  read(scope: DiscoveryScope, server: string): Promise<DiscoveryTools>;
}

export interface DiscoveryStore {
  /** Mark the server queued. The open PR and the withheld tools stay. */
  request(
    scope: DiscoveryScope,
    server: string,
    trigger: DiscoveryTrigger,
    requestedBy: string | null,
    now: Date,
  ): Promise<void>;
  /** Mark the server running, and return its row from before this call. */
  begin(
    scope: DiscoveryScope,
    server: string,
    trigger: DiscoveryTrigger,
    requestedBy: string | null,
    now: Date,
  ): Promise<DiscoveryRow | null>;
  recordSource(
    scope: DiscoveryScope,
    server: string,
    source: DiscoverySourceFields,
    now: Date,
  ): Promise<void>;
  finish(
    scope: DiscoveryScope,
    server: string,
    finish: DiscoveryFinish,
    now: Date,
  ): Promise<void>;
  read(scope: DiscoveryScope, server: string): Promise<DiscoveryRow | null>;
  list(scope: DiscoveryScope): Promise<DiscoveryRow[]>;
  /** The live mcp.mcp_servers row the published server folder wrote. */
  steeringServerId(scope: DiscoveryScope, server: string): Promise<string | null>;
  /**
   * Write each descriptor whose content differs from its newest snapshot.
   * Returns the count written.
   */
  captureSnapshots(
    scope: DiscoveryScope,
    mcpServerId: string,
    descriptors: SnapshotDescriptor[],
  ): Promise<number>;
}

/** One server the sweep or the push webhook asks to discover. */
export interface DiscoveryTarget {
  scope: DiscoveryScope;
  server: string;
}

/** An on-change server whose definition lives in a linked repository. */
export interface OnChangeTarget extends DiscoveryTarget {
  path: string;
  ref: string;
}

/** A discovery that stopped before it finished, and the trigger it had. */
export interface StalledTarget extends DiscoveryTarget {
  trigger: DiscoveryTrigger;
}

/** The cross-workspace reads of the hourly sweep and the push webhook. */
export interface DiscoverySweepStore {
  /**
   * Published steering servers whose tools discovery has not snapshotted: no
   * discovery row yet, or a finished row with no mcpServerId.
   */
  undiscovered(limit: number): Promise<DiscoveryTarget[]>;
  /** Daily servers whose last finish is older than before, or that never finished. */
  dueDaily(before: Date, limit: number): Promise<DiscoveryTarget[]>;
  /** Servers with an open sync steering PR. */
  openPullRequests(limit: number): Promise<DiscoveryTarget[]>;
  /**
   * Rows queued before before and never started, and rows that started
   * before before and never finished. A lost event or a dead worker leaves
   * such a row, and no other read picks it up.
   */
  stalled(before: Date, limit: number): Promise<StalledTarget[]>;
  /**
   * Registry servers whose workspace catalog names a newer version than the
   * one discovery last saw. A server that already ran a registry_version
   * discovery after the catalog synced that entry is left out, so one
   * catalog entry asks once, even when the discovery fails.
   */
  registryMoved(limit: number): Promise<DiscoveryTarget[]>;
  /** On-change servers whose definition lives in repo. */
  onChangeByRepo(repo: string): Promise<OnChangeTarget[]>;
}

const inScope = <T>(scope: DiscoveryScope, fn: (tx: Tx) => Promise<T>) =>
  runInTenantScope(scope, () => withTenantDb(fn));

const t = schema.mcpServerDiscoveries;

const scoped = (scope: DiscoveryScope, server: string) =>
  and(
    eq(t.orgId, scope.orgId),
    eq(t.workspaceId, scope.workspaceId),
    eq(t.server, server),
  );

function toRow(row: Row): DiscoveryRow {
  const pr =
    row.prNumber !== null && row.prUrl !== null && row.prBranch !== null
      ? { number: row.prNumber, url: row.prUrl, branch: row.prBranch }
      : null;
  return {
    id: row.id,
    server: row.server,
    mcpServerId: row.mcpServerId,
    status: row.status as DiscoveryStatus,
    trigger: row.trigger as DiscoveryTrigger,
    requestedAt: row.requestedAt,
    requestedBy: row.requestedBy,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    error: row.error,
    outcome: row.outcome as DiscoveryOutcome | null,
    toolCount: row.toolCount,
    machine: row.machine,
    sourceKind: row.sourceKind,
    sourceRepo: row.sourceRepo,
    sourcePath: row.sourcePath,
    sourceRef: row.sourceRef,
    schedule: row.schedule as SyncSchedule | null,
    upstreamDigest: row.upstreamDigest,
    latestVersion: row.latestVersion,
    pr,
    withheld: row.withheld,
  };
}

async function upsertState(
  tx: Tx,
  scope: DiscoveryScope,
  server: string,
  set: Partial<typeof t.$inferInsert>,
  trigger: DiscoveryTrigger,
  now: Date,
): Promise<void> {
  await tx
    .insert(t)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      server,
      trigger,
      createdAt: now,
      updatedAt: now,
      ...set,
    })
    .onConflictDoUpdate({
      target: [t.orgId, t.workspaceId, t.server],
      set: { ...set, trigger, updatedAt: now },
    });
}

async function readIn(
  tx: Tx,
  scope: DiscoveryScope,
  server: string,
): Promise<DiscoveryRow | null> {
  const [row] = await tx.select().from(t).where(scoped(scope, server)).limit(1);
  return row ? toRow(row) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A descriptor as a mcp.tool_snapshots row's schema_json holds it. */
function snapshotJson(d: SnapshotDescriptor): Record<string, unknown> {
  return {
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
    ...(d.annotations === undefined ? {} : { annotations: d.annotations }),
  };
}

/**
 * The content a snapshot pins. Annotations count, so a changed hint writes
 * a new row. A row with no annotations reads the same as one with null.
 */
function snapshotDigest(name: string, json: unknown): string {
  const j = record(json);
  return canonicalDigest({
    name,
    description: j?.["description"] ?? null,
    inputSchema: j?.["inputSchema"] ?? {},
    annotations: j?.["annotations"] ?? null,
  });
}

export const postgresDiscoveryStore: DiscoveryStore = {
  async request(scope, server, trigger, requestedBy, now) {
    await inScope(scope, (tx) =>
      upsertState(
        tx,
        scope,
        server,
        { status: "queued", requestedAt: now, requestedBy },
        trigger,
        now,
      ),
    );
  },

  async begin(scope, server, trigger, requestedBy, now) {
    return inScope(scope, async (tx) => {
      const prior = await readIn(tx, scope, server);
      await upsertState(
        tx,
        scope,
        server,
        {
          status: "running",
          startedAt: now,
          finishedAt: null,
          error: null,
          // A queued row keeps the person who asked. A direct run names its own.
          requestedBy: requestedBy ?? prior?.requestedBy ?? null,
          requestedAt: prior?.requestedAt ?? now,
        },
        trigger,
        now,
      );
      return prior;
    });
  },

  async recordSource(scope, server, source, now) {
    await inScope(scope, (tx) =>
      tx
        .update(t)
        .set({
          sourceKind: source.kind,
          sourceRepo: source.repo,
          sourcePath: source.path,
          sourceRef: source.ref,
          schedule: source.schedule,
          mcpServerId: source.mcpServerId,
          sourceRegistryName: source.registryName,
          sourceVersion: source.version,
          updatedAt: now,
        })
        .where(scoped(scope, server)),
    );
  },

  async finish(scope, server, finish, now) {
    // A run that waits for a machine has not finished: the claim runs it.
    const waiting = finish.status === "waiting_for_machine";
    await inScope(scope, (tx) =>
      tx
        .update(t)
        .set({
          status: finish.status,
          machineGroups: waiting ? [...(finish.machineGroups ?? [])] : [],
          outcome: finish.outcome,
          error: finish.error,
          toolCount: finish.toolCount,
          machine: finish.machine,
          upstreamDigest: finish.upstreamDigest,
          latestVersion: finish.latestVersion,
          prNumber: finish.pr?.number ?? null,
          prUrl: finish.pr?.url ?? null,
          prBranch: finish.pr?.branch ?? null,
          withheld: finish.withheld,
          // A run that stopped before the source read keeps the last names.
          ...(finish.offered === undefined ? {} : { offered: finish.offered }),
          ...(finish.withheldUpstream === undefined
            ? {}
            : { withheldUpstream: finish.withheldUpstream }),
          finishedAt: waiting ? null : now,
          updatedAt: now,
        })
        .where(scoped(scope, server)),
    );
  },

  read(scope, server) {
    return inScope(scope, (tx) => readIn(tx, scope, server));
  },

  async list(scope) {
    const rows = await inScope(scope, (tx) =>
      tx
        .select()
        .from(t)
        .where(
          and(eq(t.orgId, scope.orgId), eq(t.workspaceId, scope.workspaceId)),
        )
        .orderBy(asc(t.server)),
    );
    return rows.map(toRow);
  },

  async steeringServerId(scope, server) {
    const s = schema.mcpServers;
    const [row] = await inScope(scope, (tx) =>
      tx
        .select({ id: s.id })
        .from(s)
        .where(
          and(
            eq(s.orgId, scope.orgId),
            eq(s.workspaceId, scope.workspaceId),
            eq(s.steeringName, server),
            eq(s.origin, "steering"),
            isNull(s.deletedAt),
          ),
        )
        .limit(1),
    );
    return row?.id ?? null;
  },

  async captureSnapshots(scope, mcpServerId, descriptors) {
    if (descriptors.length === 0) return 0;
    return runInTenantScope(scope, async () => {
      const latest = await readLatestSnapshots(
        scope.orgId,
        scope.workspaceId,
        mcpServerId,
      );
      const pinned = new Map<string, string>();
      for (const snap of latest) {
        pinned.set(
          snap.toolName,
          snapshotDigest(snap.toolName, snap.schemaJson),
        );
      }
      const fresh = descriptors.filter(
        (d) => pinned.get(d.name) !== snapshotDigest(d.name, snapshotJson(d)),
      );
      if (fresh.length === 0) return 0;
      await withTenantDb((tx) =>
        tx.insert(schema.mcpToolSnapshots).values(
          fresh.map((d) => ({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            mcpServerId,
            toolName: d.name,
            schemaJson: snapshotJson(d),
            createdById: null,
          })),
        ),
      );
      return fresh.length;
    });
  },
};

export const postgresDiscoveryClaimStore: DiscoveryClaimStore = {
  async claimWaiting(scope, groups, now) {
    if (groups.length === 0) return null;
    return inScope(scope, async (tx) => {
      const [row] = await tx
        .select({
          id: t.id,
          server: t.server,
          trigger: t.trigger,
          requestedBy: t.requestedBy,
        })
        .from(t)
        .where(
          and(
            eq(t.orgId, scope.orgId),
            eq(t.workspaceId, scope.workspaceId),
            eq(t.status, "waiting_for_machine"),
            arrayOverlaps(t.machineGroups, [...groups]),
          ),
        )
        .orderBy(asc(t.requestedAt), asc(t.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (row === undefined) return null;
      await tx
        .update(t)
        .set({ status: "queued", updatedAt: now })
        .where(eq(t.id, row.id));
      return {
        server: row.server,
        trigger: row.trigger as DiscoveryTrigger,
        requestedBy: row.requestedBy,
      };
    });
  },
};

/** Tool names withheld for one server, for the gateway (lane M15). */
export async function readWithheldTools(
  scope: DiscoveryScope,
  server: string,
  store: DiscoveryStore = postgresDiscoveryStore,
): Promise<string[]> {
  const row = await store.read(scope, server);
  return row?.withheld ?? [];
}

/**
 * Every tool name withheld in one workspace, for the gateway's withheld port.
 * A full name carries its server (billing__create_refund), so one set covers
 * every server. It reads only the withheld column, because the gateway calls
 * it on every request.
 */
export async function readWorkspaceWithheldTools(
  scope: DiscoveryScope,
): Promise<Set<string>> {
  const rows = await inScope(scope, (tx) =>
    tx
      .select({ withheld: t.withheld })
      .from(t)
      .where(
        and(
          eq(t.orgId, scope.orgId),
          eq(t.workspaceId, scope.workspaceId),
          sql`cardinality(${t.withheld}) > 0`,
        ),
      ),
  );
  return new Set(rows.flatMap((row) => row.withheld));
}

function storedTool(row: {
  id: string;
  toolName: string;
  schemaJson: unknown;
  capturedAt: Date;
}): StoredTool {
  const json = record(row.schemaJson);
  const description = json?.["description"];
  return {
    name: row.toolName,
    description: typeof description === "string" ? description : null,
    inputSchema: record(json?.["inputSchema"]) ?? {},
    annotations: record(json?.["annotations"]),
    snapshotId: row.id,
    capturedAt: row.capturedAt,
  };
}

/**
 * The newest snapshot of each tool the last source read offered. Older rows
 * stay in mcp.tool_snapshots for replay, so a tool the source dropped is left
 * out by the offered list, not by its rows.
 */
export const postgresDiscoveryToolsStore: DiscoveryToolsStore = {
  read(scope, server) {
    const s = schema.mcpToolSnapshots;
    return inScope(scope, async (tx) => {
      const [row] = await tx
        .select({
          mcpServerId: t.mcpServerId,
          offered: t.offered,
          withheldUpstream: t.withheldUpstream,
        })
        .from(t)
        .where(scoped(scope, server))
        .limit(1);
      if (!row || row.mcpServerId === null || row.offered.length === 0) {
        return { withheldUpstream: row?.withheldUpstream ?? [], tools: [] };
      }
      const rows = await tx
        .selectDistinctOn([s.toolName], {
          id: s.id,
          toolName: s.toolName,
          schemaJson: s.schemaJson,
          capturedAt: s.capturedAt,
        })
        .from(s)
        .where(
          and(
            eq(s.orgId, scope.orgId),
            eq(s.workspaceId, scope.workspaceId),
            eq(s.mcpServerId, row.mcpServerId),
            inArray(s.toolName, row.offered),
          ),
        )
        .orderBy(s.toolName, desc(s.capturedAt));
      const tools = rows
        .map(storedTool)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { withheldUpstream: row.withheldUpstream, tools };
    });
  },
};

const target = (row: {
  orgId: string;
  workspaceId: string;
  server: string;
}): DiscoveryTarget => ({
  scope: { orgId: row.orgId, workspaceId: row.workspaceId },
  server: row.server,
});

export const postgresDiscoverySweepStore: DiscoverySweepStore = {
  async undiscovered(limit) {
    const s = schema.mcpServers;
    // tenancy: the scheduled hourly sweep is a deliberate cross-tenant read
    // of the shared plane. It selects the org, workspace, and folder name of
    // each live steering server whose tools discovery has not snapshotted,
    // and reads no other column. Each discovery then runs in its own
    // workspace scope.
    //
    // A server has no snapshots when it has no discovery row, or when its
    // last finished run began before its mcp.servers row existed: that run
    // recorded the offered names with no mcpServerId to write snapshots
    // under. The next run that reads the folder stamps the id, even when it
    // skips, so a server leaves this list after one such run once its row is
    // live. A server with no discovery row goes first, oldest server first.
    // The stranded rows follow by their last finish, so a folder that fails
    // on every run does not hold the head of each sweep.
    const rows = await withSystemDb((tx) =>
      tx
        .select({
          orgId: s.orgId,
          workspaceId: s.workspaceId,
          server: s.steeringName,
        })
        .from(s)
        .leftJoin(
          t,
          and(
            eq(t.orgId, s.orgId),
            eq(t.workspaceId, s.workspaceId),
            eq(t.server, s.steeringName),
          ),
        )
        .where(
          and(
            eq(s.origin, "steering"),
            isNotNull(s.steeringName),
            isNull(s.deletedAt),
            or(
              isNull(t.id),
              and(
                isNull(t.mcpServerId),
                or(eq(t.status, "succeeded"), eq(t.status, "failed")),
              ),
            ),
          ),
        )
        .orderBy(
          sql`${t.finishedAt} asc nulls first`,
          asc(s.createdAt),
          asc(s.id),
        )
        .limit(limit),
    );
    return rows.flatMap((row) =>
      row.server === null ? [] : [target({ ...row, server: row.server })],
    );
  },

  async dueDaily(before, limit) {
    // tenancy: the scheduled hourly sweep is a deliberate cross-tenant read
    // of the shared plane. It selects the org, workspace, and server of each
    // daily discovery that is due, and reads no other column.
    const rows = await withSystemDb((tx) =>
      tx
        .select({ orgId: t.orgId, workspaceId: t.workspaceId, server: t.server })
        .from(t)
        .where(
          and(
            eq(t.schedule, "daily"),
            or(eq(t.status, "succeeded"), eq(t.status, "failed")),
            or(isNull(t.finishedAt), lt(t.finishedAt, before)),
          ),
        )
        .orderBy(asc(t.finishedAt))
        .limit(limit),
    );
    return rows.map(target);
  },

  async openPullRequests(limit) {
    // tenancy: the scheduled hourly sweep is a deliberate cross-tenant read
    // of the shared plane. It selects the org, workspace, and server of each
    // row with an open sync steering PR, and reads no other column.
    const rows = await withSystemDb((tx) =>
      tx
        .select({ orgId: t.orgId, workspaceId: t.workspaceId, server: t.server })
        .from(t)
        .where(
          and(
            isNotNull(t.prNumber),
            or(eq(t.status, "succeeded"), eq(t.status, "failed")),
          ),
        )
        .orderBy(asc(t.updatedAt))
        .limit(limit),
    );
    return rows.map(target);
  },

  async stalled(before, limit) {
    // tenancy: the scheduled hourly sweep is a deliberate cross-tenant read
    // of the shared plane. It selects the org, workspace, server, and
    // trigger of each discovery that stalled, and reads no other column.
    // The oldest request goes first, so a sweep past the limit is fair.
    const rows = await withSystemDb((tx) =>
      tx
        .select({
          orgId: t.orgId,
          workspaceId: t.workspaceId,
          server: t.server,
          trigger: t.trigger,
        })
        .from(t)
        .where(
          or(
            and(eq(t.status, "queued"), lt(t.requestedAt, before)),
            and(
              eq(t.status, "running"),
              or(
                lt(t.startedAt, before),
                and(isNull(t.startedAt), lt(t.requestedAt, before)),
              ),
            ),
          ),
        )
        .orderBy(asc(t.requestedAt), asc(t.id))
        .limit(limit),
    );
    return rows.map((row) => ({
      ...target(row),
      trigger: row.trigger as DiscoveryTrigger,
    }));
  },

  async registryMoved(limit) {
    const r = schema.mcpRegistries;
    const c = schema.mcpCatalogServers;
    // tenancy: the scheduled hourly sweep is a deliberate cross-tenant read
    // of the shared plane. It joins each registry server's row to the newest
    // catalog entry of the same name in the same org and workspace, and
    // selects the org, workspace, and server of each row whose catalog moved
    // on. It reads no other column. The oldest finish goes first, so a sweep
    // past the limit is fair.
    const rows = await withSystemDb((tx) => {
      // Catalog sync upserts only the entries a page returns, so an older
      // version can keep is_latest after a newer one lands. The newest
      // published entry decides.
      const latest = tx
        .select({ version: c.version, syncedAt: c.syncedAt })
        .from(c)
        .innerJoin(r, eq(r.id, c.registryId))
        .where(
          and(
            eq(r.orgId, t.orgId),
            eq(r.workspaceId, t.workspaceId),
            eq(r.enabled, true),
            eq(c.name, t.sourceRegistryName),
            eq(c.isLatest, true),
            ne(c.status, "deleted"),
          ),
        )
        .orderBy(sql`${c.publishedAt} DESC NULLS LAST`, desc(c.syncedAt))
        .limit(1)
        .as("catalog_latest");
      return tx
        .select({ orgId: t.orgId, workspaceId: t.workspaceId, server: t.server })
        .from(t)
        .innerJoinLateral(latest, sql`true`)
        .where(
          and(
            eq(t.sourceKind, "registry"),
            isNotNull(t.sourceRegistryName),
            inArray(t.schedule, ["on-change", "daily"]),
            or(eq(t.status, "succeeded"), eq(t.status, "failed")),
            // latest_version is what the last catalog read saw. Comparing
            // source.version instead would ask every hour while the sync
            // steering PR that moves it waits for review.
            sql`${latest.version} IS DISTINCT FROM COALESCE(${t.latestVersion}, ${t.sourceVersion})`,
            // One catalog entry asks once. A registry_version discovery that
            // finished after the entry synced already answered it, even a
            // failed one, which records no latest_version.
            sql`NOT (${t.trigger} = 'registry_version' AND ${t.finishedAt} IS NOT NULL AND ${t.finishedAt} >= ${latest.syncedAt})`,
          ),
        )
        .orderBy(sql`${t.finishedAt} ASC NULLS FIRST`, asc(t.id))
        .limit(limit);
    });
    return rows.map(target);
  },

  async onChangeByRepo(repo) {
    // tenancy: a signed push webhook names a repository, not a workspace, so
    // this is a deliberate cross-tenant read of the shared plane, filtered by
    // that repository. It selects the org, workspace, server, path, and ref
    // of each on-change server whose definition lives in that repository,
    // and reads no other column.
    const rows = await withSystemDb((tx) =>
      tx
        .select({
          orgId: t.orgId,
          workspaceId: t.workspaceId,
          server: t.server,
          path: t.sourcePath,
          ref: t.sourceRef,
        })
        .from(t)
        .where(and(eq(t.schedule, "on-change"), eq(t.sourceRepo, repo))),
    );
    return rows.flatMap((row) =>
      row.path === null || row.ref === null
        ? []
        : [{ ...target(row), path: row.path, ref: row.ref }],
    );
  },
};
