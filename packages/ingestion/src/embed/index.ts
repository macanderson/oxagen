import { embedText } from "@oxagen/ai";
import { upsertEmbedding } from "../mutations/upsert-entity";
import type { EmbedRequest } from "../types";

// 1536 dims = text-embedding-3-small, matches all EntityNode vector indexes.
const EMBED_MODEL = "openai/text-embedding-3-small";

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
  });
  await upsertEmbedding(req.nodeId, vector, EMBED_MODEL, req.orgId);
}
