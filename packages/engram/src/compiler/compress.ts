/**
 * Compression strategies for cold memory items.
 *
 * Items that are above a relevance floor but below the pack line get
 * compressed to a one-line summary + retrieval handle. This preserves
 * discoverability (the agent knows the memory exists) at minimal token cost.
 */
import type { MemoryRecord } from "../types";
import { countTokens } from "./tokenizer";

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
export function compressRecord(
  record: MemoryRecord,
  score: number,
  modelId = "estimate",
): CompressedItem {
  const summary = extractSummary(
    record.kind,
    record.body as Record<string, unknown>,
  );
  // Real tokenizer count so the packer's budget math is exact (a chars/4
  // estimate under-counts token-dense code summaries). Defaults to the
  // character estimator when no model id is supplied.
  const tokenCost = countTokens(summary, modelId);

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
      // Clamp the budget to >= 0: a negative end index makes String.slice count
      // from the end (keeping almost the whole payload) rather than truncating.
      const detailBudget = Math.max(0, MAX_LEN - event.length - 20);
      const detail =
        typeof payload === "string" ? payload.slice(0, detailBudget) : "";
      return `[episodic] ${event}${outcome}${detail ? ": " + detail : ""}`.slice(
        0,
        MAX_LEN,
      );
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
