import { EMBEDDING_MODEL, embedText } from "@oxagen/ai";
import { upsertEmbedding } from "../mutations/upsert-entity";
import type { EmbedRequest } from "../types";


export function renderEntityText(
  entityType: string,
  displayName: string | undefined,
  properties: Record<string, unknown>,
): string {
  const parts: string[] = [entityType];
  if (displayName) parts.push(displayName);
  for (const [k, v] of Object.entries(properties)) {
    if (v == null) continue;
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      parts.push(`${k}:${v}`);
    }
  }
  return parts.join("  ");
}

/** The fields `upsertEntityNode` stores that `renderEntityText` reads. */
export interface StoredEntity {
  entityType: string;
  displayName: string | null;
  naturalKey: string | null;
  /** `n.properties`: the mutation's properties as a JSON string. */
  properties: string | null;
}

/**
 * The text ingestion embedded for an entity, rebuilt from the node it wrote.
 *
 * `upsertEntityNode` stores `displayName ?? naturalKey`, so a display name
 * equal to the natural key means the record had none and `renderEntityText`
 * saw `undefined`. Properties are stored as a JSON string. The embedding
 * backfill (#4148) renders through this, so a vector it writes matches the one
 * the pipeline writes for the same record.
 */
export function storedEntityText(node: StoredEntity): string {
  const displayName =
    node.displayName && node.displayName !== node.naturalKey
      ? node.displayName
      : undefined;
  return renderEntityText(
    node.entityType,
    displayName,
    parseStoredProperties(node.properties),
  );
}

/** Stored properties that are absent or not a JSON object read as `{}`. */
function parseStoredProperties(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function embedEntity(req: EmbedRequest): Promise<void> {
  const vector = await embedText(req.text, {
    telemetry: {
      orgId: req.orgId,
      workspaceId: req.workspaceId,
      surface: "ingestion",
      // No execution step for fire-and-forget ingestion embeds. Must be a UUID
      // or null — `execution_step_id` is a ClickHouse UUID column and
      // `credit_ledger.reference_id` a Postgres uuid; a synthesized string like
      // `embed:<nodeId>` broke both writes (dropped CH row + unbilled charge).
      executionStepId: null,
    },
    inputType: "document",
  });
  await upsertEmbedding(req.nodeId, vector, EMBEDDING_MODEL, req.orgId);
}
