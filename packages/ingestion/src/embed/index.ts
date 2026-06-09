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
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
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
      executionStepId: `embed:${req.nodeId}`,
    },
  });
  await upsertEmbedding(req.nodeId, vector, EMBED_MODEL, req.orgId);
}
