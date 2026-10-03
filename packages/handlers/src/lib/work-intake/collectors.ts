// collectors.ts: a workspace's work collectors, as set_work_collector writes
// them and list_work_collectors reads them (P1-03, #5103).
//
// A collector row holds the fields of one `collector/v1` document and the
// SHA-256 of that document's text (collectorFileHash). The document is the
// file a steering repo will carry once steering checks read work/ files
// (ADR-250), so the row already matches what that file will say. A new
// collector's document turns every write-back switch off. A change keeps the
// switches the row stores in write_back, so the document and the row agree.
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
  readStoredWriteBack,
  registerCollectorModules,
  type WriteBackSwitches,
} from "@oxagen/ingestion/collectors";
import { RECONCILE_INTERVAL_MINUTES } from "@oxagen/work";
import { and, asc, desc, eq, inArray, isNull, like, notLike, sql } from "drizzle-orm";
import { stringify } from "smol-toml";
import type { WorkScope } from "../work-records/store";
import { linkedGithubRepositories } from "./linked-repos";

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

/**
 * The collector/v1 document a GitHub collector's row mirrors. Every
 * write-back switch the input leaves out is off.
 */
export function renderGithubCollectorFile(input: {
  name: string;
  connection: string;
  repos: readonly string[];
  writeBack?: WriteBackSwitches;
}): string {
  const writeBack = input.writeBack ?? readStoredWriteBack("github", null);
  return stringify({
    schema: "collector/v1",
    name: input.name,
    label: input.name,
    type: "github",
    connection: input.connection,
    scope: { repos: [...input.repos] },
    write_back: {
      certify_note: writeBack.certify_note,
      send_note: writeBack.send_note,
      status: writeBack.status,
      close: writeBack.close,
      labels: writeBack.labels,
    },
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
  /** The connection's public id. Optional: the repositories' own connection is used. */
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

/** The workspace's GitHub connection by public id, or by row id for the connection a repository was linked through. */
async function githubConnection(
  tx: Tx,
  scope: WorkScope,
  by: { publicId: string } | { id: string },
): Promise<{ id: string; publicId: string }> {
  const [row] = await tx
    .select({ id: connections.id, publicId: connections.publicId, status: connections.status })
    .from(connections)
    .where(
      and(
        "publicId" in by ? eq(connections.publicId, by.publicId) : eq(connections.id, by.id),
        eq(connections.orgId, scope.orgId),
        eq(connections.workspaceId, scope.workspaceId),
        eq(connections.connectorId, "github"),
        isNull(connections.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new CollectorSetupError(
      "not_found",
      "publicId" in by
        ? `This workspace has no GitHub connection ${by.publicId}. Connect GitHub first.`
        : "The GitHub connection these repositories were linked through is gone. Connect GitHub again on the Repositories page.",
    );
  }
  if (row.status !== "connected") {
    throw new CollectorSetupError("conflict", `The GitHub connection ${row.publicId} is ${row.status}. Reconnect it, then set the collector.`);
  }
  return { id: row.id, publicId: row.publicId };
}

/**
 * The connection the named repositories were linked through. Every one of
 * them must be linked to the workspace, and all through one connection.
 */
async function linkedConnection(tx: Tx, scope: WorkScope, repos: readonly string[]): Promise<string> {
  const linked = await linkedGithubRepositories(tx, scope);
  const unlinked = repos.filter((repo) => !linked.has(repo.toLowerCase()));
  if (unlinked.length > 0) {
    throw new CollectorSetupError(
      "invalid_input",
      `${unlinked.join(", ")} ${unlinked.length === 1 ? "is" : "are"} not linked to this workspace. A collector reads only linked repositories. Link ${unlinked.length === 1 ? "it" : "them"} on the Repositories page first.`,
    );
  }
  const through = new Set(repos.map((repo) => linked.get(repo.toLowerCase())!.connectionId));
  if (through.size > 1) {
    throw new CollectorSetupError(
      "invalid_input",
      "These repositories were linked through more than one GitHub connection. Give each connection's repositories their own collector.",
    );
  }
  return [...through][0]!;
}

/**
 * Create or change a GitHub collector by name. A new collector needs
 * repositories, and each must be linked to the workspace. The collector reads
 * through the connection they were linked through; connection_id, when given,
 * must name that connection. A change keeps whatever the input leaves out.
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
  if (!existing && input.repos === undefined) {
    throw new CollectorSetupError("invalid_input", `A new collector needs repos.`);
  }

  const through = input.repos === undefined ? null : await linkedConnection(tx, scope, input.repos);
  let connection: { id: string; publicId: string } | null = null;
  if (input.connectionId !== undefined) {
    connection = await githubConnection(tx, scope, { publicId: input.connectionId });
    if (through !== null && connection.id !== through) {
      throw new CollectorSetupError(
        "invalid_input",
        `These repositories were linked through another GitHub connection than ${input.connectionId}. Leave connection_id out to read through theirs.`,
      );
    }
  } else if (through !== null) connection = await githubConnection(tx, scope, { id: through });
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
  // A change keeps the row's switches. set_work_collector sets none of them.
  const writeBack = readStoredWriteBack("github", existing?.writeBack ?? null);
  const text = renderGithubCollectorFile({ name: input.name, connection: connection.publicId, repos, writeBack });
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
        writeBack: file.file.writeBack,
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
      writeBack: file.file.writeBack,
    })
    .returning({ id: collectors.id });
  return { collectorId: row!.id, created: true, reconcile: !paused };
}

/** The workspace's collector by id, or null. */
/** The workspace's collector with this name, which is unique in the workspace. */
export async function findCollectorByName(tx: Tx, scope: WorkScope, name: string) {
  const [row] = await tx
    .select({ id: collectors.id, health: collectors.health, type: collectors.type })
    .from(collectors)
    .where(and(eq(collectors.name, name), eq(collectors.orgId, scope.orgId), eq(collectors.workspaceId, scope.workspaceId)))
    .limit(1);
  return row ?? null;
}

export async function findCollector(tx: Tx, scope: WorkScope, collectorId: string) {
  const [row] = await tx
    .select({ id: collectors.id, health: collectors.health, type: collectors.type })
    .from(collectors)
    .where(and(eq(collectors.id, collectorId), eq(collectors.orgId, scope.orgId), eq(collectors.workspaceId, scope.workspaceId)))
    .limit(1);
  return row ?? null;
}
