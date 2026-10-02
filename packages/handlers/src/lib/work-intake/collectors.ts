// collectors.ts: a workspace's work collectors, as set_work_collector writes
// them and list_work_collectors reads them (P1-03, #5103).
//
// A collector row holds the fields of one `collector/v1` document and the
// SHA-256 of that document's text (collectorFileHash). The document is the
// file a steering repo will carry once steering checks read work/ files
// (ADR-250), so the row already matches what that file will say. Phase 1
// renders every write-back switch off.
//
// Health comes from the collector's result rows in work.inbound_events: the
// latest reconcile, the last one that finished, the failed reconciles since,
// and the latest webhook delivery.
import { schema, type Tx } from "@oxagen/database";
import {
  type CollectorHealth,
  INBOUND_OUTCOMES,
  RECONCILE_KEY_PREFIX,
  readCollectorFile,
  registerCollectorModules,
} from "@oxagen/ingestion/collectors";
import { RECONCILE_INTERVAL_MINUTES } from "@oxagen/work";
import { and, asc, desc, eq, inArray, isNull, like, notLike, sql } from "drizzle-orm";
import { stringify } from "smol-toml";
import type { WorkScope } from "../work-records/store";

const collectors = schema.workCollectors;
const events = schema.workInboundEvents;
const connections = schema.sourceConnections;

/** The directory a collector's steering file lives in. */
const COLLECTOR_DIR = "work/collectors";

/** The reconcile rows read to work out the failed streak. */
const STREAK_WINDOW = 10;

/** One collector as list_work_collectors returns it. */
export interface CollectorView {
  collector_id: string;
  name: string;
  type: "github";
  connection_id: string | null;
  repos: string[];
  health: CollectorHealth;
  cursor: string | null;
  last_reconcile: { at: string; ok: boolean; pages: number; handled: number; missed: number; error: string | null } | null;
  last_success_at: string | null;
  failed_streak: number;
  next_check_at: string | null;
  last_event_at: string | null;
  created_at: string;
}

/** The collector/v1 document a GitHub collector's row mirrors, with every write-back switch off. */
export function renderGithubCollectorFile(input: { name: string; connection: string; repos: readonly string[] }): string {
  return stringify({
    schema: "collector/v1",
    name: input.name,
    label: input.name,
    type: "github",
    connection: input.connection,
    scope: { repos: [...input.repos] },
    write_back: { certify_note: false, send_note: false, status: false, close: false, labels: false },
  });
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function reconcileOf(row: { createdAt: Date; outcome: string | null; cloudevent: Record<string, unknown> }) {
  const data = (row.cloudevent.data ?? {}) as Record<string, unknown>;
  return {
    at: row.createdAt.toISOString(),
    ok: row.outcome === INBOUND_OUTCOMES.reconciled,
    pages: asNumber(data.pages),
    handled: asNumber(data.handled),
    missed: asNumber(data.missed),
    error: typeof data.error === "string" ? data.error : null,
  };
}

/** The repositories a collector's scope names, as stored. */
function reposOf(scope: Record<string, unknown>): string[] {
  return Array.isArray(scope.repos) ? scope.repos.filter((repo): repo is string => typeof repo === "string") : [];
}

/** Every collector in the workspace, with its health, oldest first. */
export async function listCollectorViews(tx: Tx, scope: WorkScope): Promise<CollectorView[]> {
  const rows = await tx
    .select()
    .from(collectors)
    .where(and(eq(collectors.orgId, scope.orgId), eq(collectors.workspaceId, scope.workspaceId)))
    .orderBy(asc(collectors.createdAt), asc(collectors.name));
  const connectionIds = rows.map((row) => row.connectionId).filter((id): id is string => id !== null);
  const publicIds = new Map<string, string>();
  if (connectionIds.length > 0) {
    const found = await tx
      .select({ id: connections.id, publicId: connections.publicId })
      .from(connections)
      .where(and(inArray(connections.id, connectionIds), eq(connections.orgId, scope.orgId), isNull(connections.deletedAt)));
    for (const entry of found) publicIds.set(entry.id, entry.publicId);
  }
  const views: CollectorView[] = [];
  for (const row of rows) {
    const reconciles = await tx
      .select({ createdAt: events.createdAt, outcome: events.outcome, cloudevent: events.cloudevent })
      .from(events)
      .where(and(eq(events.collectorId, row.id), eq(events.orgId, scope.orgId), eq(events.workspaceId, scope.workspaceId), like(events.deliveryId, `${RECONCILE_KEY_PREFIX}%`)))
      .orderBy(desc(events.createdAt))
      .limit(STREAK_WINDOW);
    const [success] = await tx
      .select({ createdAt: events.createdAt })
      .from(events)
      .where(
        and(
          eq(events.collectorId, row.id), eq(events.orgId, scope.orgId), eq(events.workspaceId, scope.workspaceId),
          like(events.deliveryId, `${RECONCILE_KEY_PREFIX}%`),
          eq(events.outcome, INBOUND_OUTCOMES.reconciled),
        ),
      )
      .orderBy(desc(events.createdAt))
      .limit(1);
    const [delivery] = await tx
      .select({ at: sql<Date>`max(${events.createdAt})` })
      .from(events)
      .where(
        and(
          eq(events.collectorId, row.id), eq(events.orgId, scope.orgId), eq(events.workspaceId, scope.workspaceId),
          notLike(events.deliveryId, `${RECONCILE_KEY_PREFIX}%`),
          notLike(events.deliveryId, "count:%"),
        ),
      );
    let failedStreak = 0;
    for (const entry of reconciles) {
      if (entry.outcome !== INBOUND_OUTCOMES.reconcileFailed) break;
      failedStreak += 1;
    }
    const latest = reconciles[0] ? reconcileOf(reconciles[0]) : null;
    const health = row.health as CollectorHealth;
    const waits = health === "paused" || health === "failing";
    const from = latest ? Date.parse(latest.at) : row.createdAt.getTime();
    const lastEvent = delivery?.at ?? null;
    views.push({
      collector_id: row.id,
      name: row.name,
      type: "github",
      connection_id: row.connectionId === null ? null : (publicIds.get(row.connectionId) ?? null),
      repos: reposOf(row.scope),
      health,
      cursor: row.cursor,
      last_reconcile: latest,
      last_success_at: success ? success.createdAt.toISOString() : null,
      failed_streak: failedStreak,
      next_check_at: waits ? null : new Date(from + RECONCILE_INTERVAL_MINUTES * 60_000).toISOString(),
      last_event_at: lastEvent === null ? null : new Date(lastEvent).toISOString(),
      created_at: row.createdAt.toISOString(),
    });
  }
  return views;
}

/** A refused collector write, with the message a person reads. */
export class CollectorSetupError extends Error {
  constructor(
    readonly code: "invalid_input" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "CollectorSetupError";
  }
}

/** What set_work_collector asks for. */
export interface SetCollectorInput {
  name: string;
  /** The connection's public id. Required to create a collector. */
  connectionId?: string;
  repos?: string[];
  paused?: boolean;
  actorUserId: string;
}

/** What a write did. */
export interface SetCollectorResult {
  collectorId: string;
  created: boolean;
  /** True when the collector should read its repositories now. */
  reconcile: boolean;
}

/** The workspace's GitHub connection by public id. */
async function githubConnection(tx: Tx, scope: WorkScope, publicId: string): Promise<{ id: string; publicId: string }> {
  const [row] = await tx
    .select({ id: connections.id, publicId: connections.publicId, status: connections.status })
    .from(connections)
    .where(
      and(
        eq(connections.publicId, publicId),
        eq(connections.orgId, scope.orgId),
        eq(connections.workspaceId, scope.workspaceId),
        eq(connections.connectorId, "github"),
        isNull(connections.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new CollectorSetupError("not_found", `This workspace has no GitHub connection ${publicId}. Connect GitHub first.`);
  if (row.status !== "connected") {
    throw new CollectorSetupError("conflict", `The GitHub connection ${publicId} is ${row.status}. Reconnect it, then set the collector.`);
  }
  return { id: row.id, publicId: row.publicId };
}

/**
 * Create or change a GitHub collector by name. A new collector needs a
 * connection and repositories. A change keeps whatever the input leaves out.
 * Pausing keeps the collector's deliveries, and resuming reads it again.
 */
export async function setCollector(tx: Tx, scope: WorkScope, input: SetCollectorInput): Promise<SetCollectorResult> {
  registerCollectorModules();
  const [existing] = await tx
    .select()
    .from(collectors)
    .where(and(eq(collectors.orgId, scope.orgId), eq(collectors.workspaceId, scope.workspaceId), eq(collectors.name, input.name)))
    .limit(1)
    .for("update");
  if (existing && existing.type !== "github") {
    throw new CollectorSetupError("conflict", `${input.name} is a ${existing.type} collector. Give a GitHub collector its own name.`);
  }
  if (!existing && (input.connectionId === undefined || input.repos === undefined)) {
    throw new CollectorSetupError("invalid_input", `A new collector needs connection_id and repos.`);
  }

  let connection: { id: string; publicId: string } | null = null;
  if (input.connectionId !== undefined) connection = await githubConnection(tx, scope, input.connectionId);
  else if (existing?.connectionId) {
    const [row] = await tx
      .select({ id: connections.id, publicId: connections.publicId })
      .from(connections)
      .where(and(eq(connections.id, existing.connectionId), eq(connections.orgId, scope.orgId)))
      .limit(1);
    connection = row ?? null;
  }
  if (connection === null) {
    throw new CollectorSetupError("invalid_input", `The collector ${input.name} has no GitHub connection. Set connection_id.`);
  }

  const repos = [...new Set(input.repos ?? reposOf(existing?.scope ?? {}))];
  const text = renderGithubCollectorFile({ name: input.name, connection: connection.publicId, repos });
  const file = readCollectorFile(`${COLLECTOR_DIR}/${input.name}.toml`, text);
  if (!file.ok) throw new CollectorSetupError("invalid_input", file.errors.join("; "));

  const wasPaused = existing?.health === "paused";
  const paused = input.paused ?? wasPaused;
  const health: CollectorHealth = paused ? "paused" : wasPaused ? "healthy" : ((existing?.health as CollectorHealth | undefined) ?? "healthy");
  const before = new Set(existing ? reposOf(existing.scope).map((repo) => repo.toLowerCase()) : []);
  const after = repos.map((repo) => repo.toLowerCase());
  const reposChanged = after.length !== before.size || after.some((repo) => !before.has(repo));
  // The cursor is a time, and a reconcile reads every repository from it. A
  // repository the collector did not read before, or another connection, has
  // issues older than the cursor that no read has seen, so the next reconcile
  // starts from the beginning. Items already stored are not written twice.
  const readFromStart = after.some((repo) => !before.has(repo)) || existing?.connectionId !== connection.id;

  if (existing) {
    await tx
      .update(collectors)
      .set({
        connectionId: connection.id,
        scope: file.file.scope,
        health,
        fileHash: file.file.fileHash,
        ...(readFromStart ? { cursor: null } : {}),
        updatedAt: sql`now()`,
        updatedById: input.actorUserId,
      })
      .where(and(eq(collectors.id, existing.id), eq(collectors.orgId, scope.orgId), eq(collectors.workspaceId, scope.workspaceId)));
    return {
      collectorId: existing.id,
      created: false,
      reconcile: !paused && (wasPaused || reposChanged || readFromStart),
    };
  }
  const [row] = await tx
    .insert(collectors)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      createdById: input.actorUserId,
      name: input.name,
      type: "github",
      connectionId: connection.id,
      scope: file.file.scope,
      health,
      fileHash: file.file.fileHash,
    })
    .returning({ id: collectors.id });
  return { collectorId: row!.id, created: true, reconcile: !paused };
}

/** The workspace's collector by id, or null. */
export async function findCollector(tx: Tx, scope: WorkScope, collectorId: string) {
  const [row] = await tx
    .select({ id: collectors.id, health: collectors.health, type: collectors.type })
    .from(collectors)
    .where(and(eq(collectors.id, collectorId), eq(collectors.orgId, scope.orgId), eq(collectors.workspaceId, scope.workspaceId)))
    .limit(1);
  return row ?? null;
}
