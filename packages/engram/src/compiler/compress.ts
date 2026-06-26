/**
 * Compression strategies for cold memory items.
 *
 * Items that are above a relevance floor but below the pack line get
 * compressed to a one-line summary + retrieval handle. This preserves
 * discoverability (the agent knows the memory exists) at minimal token cost.
 */
import type { MemoryRecord } from "../types";

export interface CompressedItem {
  /** Record ID for engram.recall() page-back-in. */
  recordId: string;
  /** Short summary, ≤50 tokens. */
  summary: string;
  /** Original fused score (for ordering). */
  score: number;
  /** Token cost of the summary. */
  tokenCost: number;
}

/**
 * Compress a memory record into a short summary + handle.
 * The summary is the first meaningful sentence from the body, truncated.
 */
export function compressRecord(record: MemoryRecord, score: number): CompressedItem {
  const summary = extractSummary(record.kind, record.body as Record<string, unknown>);
  // Estimate ~4 chars per token for the summary
  const tokenCost = Math.max(1, Math.ceil(summary.length / 4));

  return {
    recordId: record.id,
    summary,
    score,
    tokenCost,
  };
}

/**
 * Extract a short summary from a record body based on its kind.
 * Target: ≤200 characters (roughly 50 tokens).
 */
function extractSummary(kind: string, body: Record<string, unknown>): string {
  const MAX_LEN = 200;

  switch (kind) {
    case "episodic": {
      const event = (body.event as string) ?? "event";
      const outcome = body.outcome ? ` (${body.outcome})` : "";
      const payload = body.payload;
      const detail = typeof payload === "string"
        ? payload.slice(0, MAX_LEN - event.length - 20)
        : "";
      return `[episodic] ${event}${outcome}${detail ? ": " + detail : ""}`.slice(0, MAX_LEN);
    }
    case "semantic": {
      const fact = (body.fact as string) ?? "";
      return `[fact] ${fact}`.slice(0, MAX_LEN);
    }
    case "procedural": {
      const rule = (body.rule as string) ?? "";
      return `[rule] ${rule}`.slice(0, MAX_LEN);
    }
    case "entity": {
      const name = (body.name as string) ?? "";
      const entityType = (body.entityType as string) ?? "";
      return `[entity] ${entityType}: ${name}`.slice(0, MAX_LEN);
    }
    case "edge": {
      const edgeType = (body.edgeType as string) ?? "";
      return `[edge] ${edgeType}`.slice(0, MAX_LEN);
    }
    default:
      return `[memory] ${JSON.stringify(body).slice(0, MAX_LEN - 10)}`;
  }
}
