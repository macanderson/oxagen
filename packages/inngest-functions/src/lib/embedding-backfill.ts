/**
 * Graph reads and writes for the embedding backfill (#4148).
 *
 * The backfill set is every text-bearing node with a vector index whose
 * `embedding` is null: records ingested while embeddings were down, and every
 * vector the 1,024-dimension migration cleared. Two node kinds are written with
 * a vector today, so two are backfilled:
 *
 *   - `:EntityNode`, embedded by the ingestion pipeline from
 *     `renderEntityText`, rebuilt here from the stored node by
 *     `storedEntityText` and written back by the pipeline's own
 *     `upsertEmbedding`.
 *   - `:AgentMemory`, embedded from its `lesson` by `agent.memory.write`,
 *     read and written through the memory repository.
 *
 * `:Document` and `:Message` carry vector indexes, but no code writes either
 * node with a vector, so neither is here.
 *
 * Every read and write runs in one workspace's tenant scope through
 * `scopedSession()`, which resolves the organisation's graph plane. That plane
 * is the pooled database, the organisation's own `org-<namespace>` database
 * (ADR-098), or a dedicated plane (ADR-042), so walking the workspaces reaches
 * every database the product reads from.
 */
import { asc, eq } from "drizzle-orm";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { scopedSession } from "@oxagen/ontology";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  EMBEDDING_MODEL,
  embedMany,
  type EmbeddingUnavailableError,
} from "@oxagen/ai";
import { storedEntityText } from "@oxagen/ingestion/embed";
import { upsertEmbedding } from "@oxagen/ingestion/mutations";
import {
  shouldRunInference,
  type DeliveryConfig,
} from "@oxagen/ingestion/filters";
import {
  findMemoriesMissingEmbedding,
  readMemoryLessonsMissingEmbedding,
  setMemoryEmbeddings,
} from "@oxagen/agent/memory/neo4j";
import { countOf } from "./driver-count";

export interface WorkspaceScope {
  orgId: string;
  workspaceId: string;
}

export type BackfillKind = "memory" | "entity";

/** One node to embed: a memory by `id`, an entity by `publicId`. */
export interface BackfillItem {
  kind: BackfillKind;
  id: string;
}

export interface WorkspaceSelection {
  /** Nodes with no vector that the backfill can embed. */
  missing: number;
  /** Nodes with no vector that it leaves alone: opted out, or no text. */
  excluded: number;
  /** Up to the requested limit of `missing`, memories first. */
  items: BackfillItem[];
}

/** One `embedMany` call. One workspace, so one org is metered and billed. */
export interface BackfillBatch extends WorkspaceScope {
  items: BackfillItem[];
}

export type BatchOutcome =
  | {
      status: "done";
      /** Nodes that received a vector. */
      embedded: number;
      /** Nodes embedded, edited, or deleted since selection. */
      skipped: number;
    }
  | {
      status: "unavailable";
      statusCode: number | null;
      reason: string;
    };

/** Every workspace, oldest id first. */
export async function listWorkspaces(): Promise<WorkspaceScope[]> {
  // tenancy: scheduled global sweep across all orgs reads only orgId and
  // workspace id, and every graph read and write re-enters that workspace's
  // scope through runInTenantScope before it touches a node.
  const rows = await withSystemDb((tx) =>
    tx.query.workspaces.findMany({
      columns: { id: true, orgId: true },
      orderBy: [asc(schema.workspaces.id)],
    }),
  );
  return rows.map((row) => ({ orgId: row.orgId, workspaceId: row.id }));
}

/**
 * Which entities a workspace lets Oxagen embed, read from each connection's
 * `delivery_config.semanticInference`: the opt-out the pipeline honours through
 * `shouldRunInference`.
 */
export interface EntityEmbeddingPolicy {
  /** Connections that allow embedding of at least some record types. */
  connectionIds: string[];
  /** `<connectionId>:<sourceRecordType>` pairs a connection turned off. */
  optedOutRecordTypes: string[];
}

export function entityEmbeddingPolicy(
  connections: { id: string; deliveryConfig: unknown }[],
): EntityEmbeddingPolicy {
  const policy: EntityEmbeddingPolicy = {
    connectionIds: [],
    optedOutRecordTypes: [],
  };
  for (const connection of connections) {
    const config = connection.deliveryConfig as DeliveryConfig | null;
    const inference = config?.semanticInference;
    // shouldRunInference refuses every record type when `enabled` is false.
    if (inference && !inference.enabled) continue;
    policy.connectionIds.push(connection.id);
    for (const recordType of Object.keys(inference?.perRecordType ?? {})) {
      if (!shouldRunInference(recordType, inference)) {
        policy.optedOutRecordTypes.push(`${connection.id}:${recordType}`);
      }
    }
  }
  return policy;
}

/**
 * The active workspace's embedding policy. Soft-deleted connections are read
 * too: `connection_only` deletion leaves their nodes in the graph, and the
 * opt-out still applies to them. An entity whose connection row is gone is
 * not embedded, since nothing records whether it allowed embedding.
 */
async function loadEntityEmbeddingPolicy(
  workspaceId: string,
): Promise<EntityEmbeddingPolicy> {
  const connections = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.sourceConnections.id,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
      })
      .from(schema.sourceConnections)
      .where(eq(schema.sourceConnections.workspaceId, workspaceId)),
  );
  return entityEmbeddingPolicy(connections);
}

/**
 * An entity the backfill can embed: a publicId to write back to, a type to
 * render, and a connection whose policy allows its record type.
 */
const EMBEDDABLE_ENTITY = /* cypher */ `n.publicId IS NOT NULL
          AND coalesce(n.entityType, n.label) IS NOT NULL
          AND coalesce(n.connectionId IN $connectionIds, false)
          AND NOT coalesce(n.connectionId + ':' + n.sourceRecordType, '') IN $optedOutRecordTypes`;

async function findEntitiesMissingEmbedding(
  policy: EntityEmbeddingPolicy,
  limit: number,
): Promise<{ missing: number; excluded: number; ids: string[] }> {
  const s = scopedSession();
  try {
    const counted = await s.run(
      /* cypher */ `
        MATCH (n:EntityNode {orgId: $orgId, workspaceId: $workspaceId})
        WHERE n.embedding IS NULL
        WITH ${EMBEDDABLE_ENTITY} AS embeddable
        RETURN count(CASE WHEN embeddable THEN 1 END) AS missing,
               count(CASE WHEN embeddable THEN null ELSE 1 END) AS excluded
      `,
      { ...policy },
    );
    const missing = countOf(counted.records[0]?.get("missing"));
    const excluded = countOf(counted.records[0]?.get("excluded"));
    if (missing === 0 || limit <= 0) return { missing, excluded, ids: [] };

    const listed = await s.run(
      /* cypher */ `
        MATCH (n:EntityNode {orgId: $orgId, workspaceId: $workspaceId})
        WHERE n.embedding IS NULL
          AND ${EMBEDDABLE_ENTITY}
        RETURN n.publicId AS id
        LIMIT $limit
      `,
      { ...policy, limit: BigInt(limit) },
    );
    return {
      missing,
      excluded,
      ids: listed.records.map((r) => r.get("id") as string),
    };
  } finally {
    await s.close();
  }
}

/**
 * Count one workspace's nodes with no vector and choose up to `limit` of them,
 * memories first. A limit of zero still counts, so the run can report what is
 * left.
 */
export function selectWorkspace(
  scope: WorkspaceScope,
  limit: number,
): Promise<WorkspaceSelection> {
  return runInTenantScope(scope, async (): Promise<WorkspaceSelection> => {
    const memories = await findMemoriesMissingEmbedding(limit);
    const policy = await loadEntityEmbeddingPolicy(scope.workspaceId);
    const entities = await findEntitiesMissingEmbedding(
      policy,
      limit - memories.ids.length,
    );
    return {
      missing: memories.missing + entities.missing,
      excluded: memories.excluded + entities.excluded,
      items: [
        ...memories.ids.map((id) => ({ kind: "memory" as const, id })),
        ...entities.ids.map((id) => ({ kind: "entity" as const, id })),
      ],
    };
  });
}

/** The texts of `ids` that still have no vector, as ingestion rendered them. */
async function readEntityTexts(
  ids: string[],
): Promise<{ id: string; text: string }[]> {
  if (ids.length === 0) return [];
  const s = scopedSession();
  try {
    const result = await s.run(
      /* cypher */ `
        MATCH (n:EntityNode {orgId: $orgId, workspaceId: $workspaceId})
        WHERE n.publicId IN $ids AND n.embedding IS NULL
        RETURN n.publicId AS id,
               coalesce(n.entityType, n.label) AS entityType,
               n.displayName AS displayName,
               n.naturalKey AS naturalKey,
               n.properties AS properties
      `,
      { ids },
    );
    return result.records.map((r) => {
      const properties: unknown = r.get("properties");
      return {
        id: r.get("id") as string,
        text: storedEntityText({
          entityType: r.get("entityType") as string,
          displayName: (r.get("displayName") as string | null) ?? null,
          naturalKey: (r.get("naturalKey") as string | null) ?? null,
          properties: typeof properties === "string" ? properties : null,
        }),
      };
    });
  } finally {
    await s.close();
  }
}

function isEmbeddingUnavailable(
  err: unknown,
): err is EmbeddingUnavailableError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "embedding_unavailable"
  );
}

function vectorAt(vectors: number[][], index: number): number[] {
  const vector = vectors[index];
  if (!vector) {
    throw new Error(
      `embedMany returned ${vectors.length} vectors, and the backfill needed vector ${index + 1}`,
    );
  }
  return vector;
}

/**
 * Embed one batch in one `embedMany` call and write each vector back.
 *
 * The texts are read again here rather than carried from selection, so a
 * retried step embeds only what is still missing and no text or vector crosses
 * a step boundary. Unavailable embeddings come back as an outcome instead of a
 * throw: the run stops, and the next run tries again. Any other failure
 * throws, and the step retries.
 */
export function embedBatch(batch: BackfillBatch): Promise<BatchOutcome> {
  const { orgId, workspaceId } = batch;
  return runInTenantScope({ orgId, workspaceId }, () => embedInScope(batch));
}

async function embedInScope(batch: BackfillBatch): Promise<BatchOutcome> {
  const { orgId, workspaceId } = batch;
  const idsOf = (kind: BackfillKind) =>
    batch.items.filter((item) => item.kind === kind).map((item) => item.id);

  const memories = await readMemoryLessonsMissingEmbedding(idsOf("memory"));
  const entities = await readEntityTexts(idsOf("entity"));
  const texts = [
    ...memories.map((memory) => memory.lesson),
    ...entities.map((entity) => entity.text),
  ];
  if (texts.length === 0) {
    return { status: "done", embedded: 0, skipped: batch.items.length };
  }

  let vectors: number[][];
  try {
    vectors = await embedMany(texts, {
      telemetry: {
        orgId,
        workspaceId,
        surface: "ingestion",
        executionStepId: null,
      },
      inputType: "document",
    });
  } catch (err) {
    if (!isEmbeddingUnavailable(err)) throw err;
    return {
      status: "unavailable",
      statusCode: err.statusCode ?? null,
      reason: err.providerMessage?.slice(0, 300) ?? err.message,
    };
  }

  const memoriesWritten = await setMemoryEmbeddings(
    memories.map((memory, i) => ({
      id: memory.id,
      lesson: memory.lesson,
      embedding: vectorAt(vectors, i),
    })),
    EMBEDDING_MODEL,
  );
  // upsertEmbedding is the pipeline's own write, so a backfilled entity carries
  // the same fields as a fresh one. It does not check that the node is still
  // missing a vector. If ingestion re-embedded the node in the seconds since
  // the read above, this vector replaces that one.
  for (const [i, entity] of entities.entries()) {
    await upsertEmbedding(
      entity.id,
      vectorAt(vectors, memories.length + i),
      EMBEDDING_MODEL,
      orgId,
    );
  }

  const embedded = memoriesWritten + entities.length;
  return { status: "done", embedded, skipped: batch.items.length - embedded };
}
