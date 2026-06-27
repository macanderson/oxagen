import { embedText } from "@oxagen/ai";
import { upsertEmbedding } from "../mutations/upsert-entity";
import type { EmbedRequest } from "../types";
import type { ParsedSymbol } from "../parsers/types";

export { chunkText } from "./chunk";
export type { TextChunk, ChunkOptions, ChunkResult } from "./chunk";

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

/**
 * Build the embedding text for a whole source file: its path/language, the
 * document title or leading symbol names for orientation, and the head of the
 * actual content. Embedding real content (not just the path + symbol names) is
 * what makes "find the code that does X" work.
 */
export function renderFileText(args: {
  path: string;
  language: string;
  content: string;
  title?: string;
  symbolNames?: string[];
}): string {
  const head = args.content.slice(0, 1500);
  return [
    args.path,
    args.language,
    args.title ?? "",
    (args.symbolNames ?? []).slice(0, 40).join(" "),
    head,
  ]
    .filter((p) => p.length > 0)
    .join("\n");
}

/**
 * Build the embedding text for a single symbol (function/class/method/heading):
 * its kind + name + signature + leading doc comment + the code slice itself, so a
 * natural-language query like "function that retries on 5xx" matches the body.
 */
export function renderSymbolText(symbol: ParsedSymbol, path: string): string {
  return [
    `${symbol.kind} ${symbol.name}`,
    path,
    symbol.signature ?? "",
    symbol.docComment ?? "",
    symbol.code ?? "",
  ]
    .filter((p) => p.length > 0)
    .join("\n");
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
