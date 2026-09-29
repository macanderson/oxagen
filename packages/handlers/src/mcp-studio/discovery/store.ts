// store.ts: the Postgres side of discovery (lane M10, #4682).
//
// mcp.server_discoveries holds one row per workspace and server folder: the
// last discovery's state, the source fields the push webhook matches on, the
// open sync steering PR, and the tools the gateway withholds until it merges.
//
// The scoped store opens the workspace's tenant transaction and filters by
// the scope as well, so one missing policy still leaks no row. The sweep
// store reads across workspaces with withSystemDb, and each of its queries
// says why in a tenancy comment.
import { schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import {
  captureToolSnapshots,
  descriptorHash,
  readLatestSnapshots,
} from "@oxagen/agent/runtime/mcp-snapshots";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, asc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import type {
  DiscoveryOutcome,
  DiscoveryScope,
  DiscoveryTrigger,
  SyncSchedule,
} from "./types";

type Row = typeof schema.mcpServerDiscoveries.$inferSelect;

export type DiscoveryStatus = "queued" | "running" | "succeeded" | "failed";

/** One server's discovery state. */
export interface DiscoveryRow {
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
}

/** What a finished discovery writes. */
export interface DiscoveryFinish {
  status: "succeeded" | "failed";
  outcome: DiscoveryOutcome | null;
  error: string | null;
  toolCount: number | null;
  machine: string | null;
  upstreamDigest: string | null;
  latestVersion: string | null;
  pr: { number: number; url: string; branch: string } | null;
  withheld: string[];
}

/** One tool the source offered, as mcp.tool_snapshots stores it. */
export interface SnapshotDescriptor {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
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

/** The cross-workspace reads of the hourly sweep and the push webhook. */
export interface DiscoverySweepStore {
  /** Published steering servers with no discovery row yet. */
  undiscovered(limit: number): Promise<DiscoveryTarget[]>;
  /** Daily servers whose last finish is older than before, or that never finished. */
  dueDaily(before: Date, limit: number): Promise<DiscoveryTarget[]>;
  /** Servers with an open sync steering PR. */
  openPullRequests(limit: number): Promise<DiscoveryTarget[]>;
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
          updatedAt: now,
        })
        .where(scoped(scope, server)),
    );
  },

  async finish(scope, server, finish, now) {
    await inScope(scope, (tx) =>
      tx
        .update(t)
        .set({
          status: finish.status,
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
          finishedAt: now,
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
        const json = snap.schemaJson as Partial<SnapshotDescriptor> | null;
        pinned.set(
          snap.toolName,
          descriptorHash({
            name: snap.toolName,
            description: json?.description ?? null,
            inputSchema: json?.inputSchema ?? {},
          }),
        );
      }
      const fresh = descriptors.filter(
        (d) => pinned.get(d.name) !== descriptorHash(d),
      );
      return captureToolSnapshots({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        mcpServerId,
        descriptors: fresh,
      });
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
    // tenancy: the hourly sweep is a deliberate cross-tenant read of the
    // shared plane. It selects the org, workspace, and folder name of each
    // live steering server with no discovery row, and reads no other column.
    // Each discovery then runs in its own workspace scope.
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
            isNull(t.id),
          ),
        )
        .limit(limit),
    );
    return rows.flatMap((row) =>
      row.server === null ? [] : [target({ ...row, server: row.server })],
    );
  },

  async dueDaily(before, limit) {
    // tenancy: the hourly sweep is a deliberate cross-tenant read of the
    // shared plane. It selects the org, workspace, and server of each daily
    // discovery that is due, and reads no other column.
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
    // tenancy: the hourly sweep is a deliberate cross-tenant read of the
    // shared plane. It selects the org, workspace, and server of each row
    // with an open sync steering PR, and reads no other column.
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

  async onChangeByRepo(repo) {
    // tenancy: a push webhook names a repository, not a workspace, so this
    // is a deliberate cross-tenant read of the shared plane. It selects the
    // org, workspace, server, path, and ref of each on-change server whose
    // definition lives in that repository, and reads no other column.
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
