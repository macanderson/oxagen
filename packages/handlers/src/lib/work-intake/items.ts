// items.ts: how work intake creates and updates a work.items row (P1-03,
// #5103), for a collector and for a person who enters an item by hand.
//
// The row holds what the source says. Its history and its state are the P1-02
// records (ADR-244): after each write here the caller records the material
// fields with recordSource, in the same transaction, so the row and its facts
// never disagree. Nothing here writes a person's planning priority, the state,
// or the triage decision, so a source update never overwrites a person's edit.
//
// One provider item is one work item in a workspace, whichever collector heard
// it: the row is found on (org, workspace, provider id), and a transaction
// lock on that key keeps two deliveries of one item from both inserting it.
import { schema, type Tx } from "@oxagen/database";
import type { WorkItemInput } from "@oxagen/ingestion/collectors";
import { type SourceMaterial, sourceDigest } from "@oxagen/work/records";
import { and, eq, sql } from "drizzle-orm";
import type { WorkScope } from "../work-records/store";

const items = schema.workItems;

/** The prefix of every work item number a workspace says out loud, such as WI-19. */
export const WORK_ITEM_NUMBER_PREFIX = "WI-";

/** The Priority labels, most urgent first (tasks-spec.md §6.4). */
const PRIORITY_LABELS = ["P0", "P1", "P2", "P3"] as const;

/** Hold a transaction lock on one key in one workspace. */
async function lock(tx: Tx, scope: WorkScope, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`work.items:${scope.workspaceId}:${key}`}, 0))`);
}

/**
 * The workspace's next work item number. The caller's transaction holds the
 * workspace's number lock until it commits, so two inserts never take one
 * number.
 */
export async function nextItemNumber(tx: Tx, scope: WorkScope): Promise<string> {
  await lock(tx, scope, "number");
  const [row] = await tx.execute<{ highest: number | null }>(sql`
    select max((substring(${items.number} from ${`^${WORK_ITEM_NUMBER_PREFIX}([0-9]+)$`}))::int) as highest
    from ${items}
    where ${items.orgId} = ${scope.orgId} and ${items.workspaceId} = ${scope.workspaceId}
  `);
  return `${WORK_ITEM_NUMBER_PREFIX}${Number(row?.highest ?? 0) + 1}`;
}

/** The most urgent Priority label among the labels, or null. */
export function priorityFromLabels(labels: readonly string[]): (typeof PRIORITY_LABELS)[number] | null {
  return PRIORITY_LABELS.find((label) => labels.includes(label)) ?? null;
}

/**
 * The dedupe key of a source reading: the time the source names and the
 * material digest, so the same text read twice records once, and text that
 * changes back to an earlier version still records.
 */
export function sourceDedupeKey(material: SourceMaterial, occurredAt: string): string {
  return `source:${occurredAt}:${sourceDigest(material).slice("sha256:".length, "sha256:".length + 16)}`;
}

/** The stored row a collector compares against. */
export interface IntakeItemRow {
  id: string;
  publicId: string;
  subject: string;
  description: string | null;
  labels: string[];
  sourceUpdatedAt: string | null;
  deleted: boolean;
}

function toRow(row: {
  id: string;
  publicId: string;
  subject: string;
  description: string | null;
  labels: string[];
  sourceUpdatedAt: Date | null;
  deletedAt: Date | null;
}): IntakeItemRow {
  return {
    id: row.id,
    publicId: row.publicId,
    subject: row.subject,
    description: row.description,
    labels: [...row.labels],
    sourceUpdatedAt: row.sourceUpdatedAt === null ? null : row.sourceUpdatedAt.toISOString(),
    deleted: row.deletedAt !== null,
  };
}

const rowColumns = {
  id: items.id,
  publicId: items.publicId,
  subject: items.subject,
  description: items.description,
  labels: items.labels,
  sourceUpdatedAt: items.sourceUpdatedAt,
  deletedAt: items.deletedAt,
};

/** The workspace's item for a provider id, soft-deleted or not. */
export async function findProviderItem(tx: Tx, scope: WorkScope, providerId: string): Promise<IntakeItemRow | null> {
  const [row] = await tx
    .select(rowColumns)
    .from(items)
    .where(and(eq(items.orgId, scope.orgId), eq(items.workspaceId, scope.workspaceId), eq(items.providerId, providerId)))
    .limit(1);
  return row ? toRow(row) : null;
}

const date = (value: string | null): Date | null => (value === null ? null : new Date(value));

/** The source columns a provider owns. A person's planning priority, the state, and triage are not among them. */
function providerColumns(input: WorkItemInput) {
  return {
    subject: input.subject,
    description: input.description,
    labels: [...input.labels],
    owner: input.owner,
    sourceCreatedBy: input.sourceCreatedBy,
    sourceCreatedAt: date(input.sourceCreatedAt),
    sourceUpdatedBy: input.sourceUpdatedBy,
    sourceUpdatedAt: date(input.sourceUpdatedAt),
    closedAt: date(input.closedAt),
    status: input.status,
    statusCategory: input.statusCategory,
    resolution: input.resolution,
    sourceUrl: input.sourceUrl,
    priority: priorityFromLabels(input.labels),
    priorityRaw: input.priorityRaw,
    estimateMinutes: input.estimateMinutes,
    requester: input.requester,
    tainted: [...input.tainted],
    sourceRepository: input.sourceRepository ?? null,
  };
}

/** True when the stored copy changed later than the copy being written. */
function storedIsNewer(stored: string | null, incoming: string | null): boolean {
  if (stored === null || incoming === null) return false;
  return Date.parse(stored) > Date.parse(incoming);
}

/**
 * Insert or update the workspace's item for a provider id. The input is
 * already screened. A new item takes the workspace's next number and keeps
 * the collector that first heard it. Returns the row before the write (null
 * when new) and after it. Under the lock, a stored copy newer than the input
 * wins: nothing is written and `stale` is true, so two reads of one issue
 * that overlap cannot leave the older text on the row.
 */
export async function upsertProviderItem(
  tx: Tx,
  scope: WorkScope,
  collectorId: string,
  input: WorkItemInput,
): Promise<{ before: IntakeItemRow | null; after: IntakeItemRow; created: boolean; stale: boolean }> {
  await lock(tx, scope, `source:${input.providerId}`);
  const before = await findProviderItem(tx, scope, input.providerId);
  if (before && storedIsNewer(before.sourceUpdatedAt, input.sourceUpdatedAt)) {
    return { before, after: before, created: false, stale: true };
  }
  if (before) {
    const [row] = await tx
      .update(items)
      .set({ ...providerColumns(input), updatedAt: sql`now()` })
      .where(and(eq(items.id, before.id), eq(items.orgId, scope.orgId), eq(items.workspaceId, scope.workspaceId)))
      .returning(rowColumns);
    return { before, after: toRow(row!), created: false, stale: false };
  }
  const number = await nextItemNumber(tx, scope);
  const [row] = await tx
    .insert(items)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      number,
      origin: input.origin,
      providerId: input.providerId,
      collectorId,
      ...providerColumns(input),
    })
    .returning(rowColumns);
  return { before: null, after: toRow(row!), created: true, stale: false };
}

/** What a person enters by hand. */
export interface ManualItemInput {
  subject: string;
  description: string | null;
  labels: string[];
  /** The repository the work belongs to, as owner/name, when the person names one. */
  repository: string | null;
  /** The user id of the person. */
  actorUserId: string;
  /** The person's name as the item shows it. */
  requester: string | null;
}

/** Insert a work item a person entered in Oxagen. The input is already screened. */
export async function insertManualItem(tx: Tx, scope: WorkScope, input: ManualItemInput): Promise<IntakeItemRow & { number: string }> {
  const number = await nextItemNumber(tx, scope);
  const [row] = await tx
    .insert(items)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      createdById: input.actorUserId,
      number,
      origin: "manual",
      subject: input.subject,
      description: input.description,
      labels: [...input.labels],
      priority: priorityFromLabels(input.labels),
      requester: input.requester,
      sourceRepository: input.repository,
      sourceCreatedBy: input.requester,
      sourceCreatedAt: sql`now()`,
      sourceUpdatedAt: sql`now()`,
    })
    .returning(rowColumns);
  return { ...toRow(row!), number };
}
