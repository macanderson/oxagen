/**
 * Cache-aware layout — arranges packed content into a prompt-cache-stable
 * context window where the prefix is byte-identical across turns.
 *
 * Stable sections (system prompt, procedural rules, project facts) are placed
 * first in deterministic order. Volatile sections (retrieved, working) are
 * placed at the tail. This maximizes prompt cache hit rates.
 */
import type { MemoryRecord } from "../types";
import type { CompressedItem } from "./compress";
import type { TokenUsage } from "./packer";
import {
  type ContextSection,
  type SectionType,
  SECTION_POSITIONS,
  SECTION_STABILITY,
} from "./sections";
import { countTokens } from "./tokenizer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextWindow {
  sections: ContextSection[];
  tokenUsage: TokenUsage;
  cachePrefix: {
    stableBytes: number;
    totalBytes: number;
    hitRate: number;
  };
  metadata: CompileMetadata;
}

export interface CompileMetadata {
  compiledAt: number;
  retrievalMs: number;
  packingMs: number;
  layoutMs: number;
  totalMs: number;
  candidatesRetrieved: number;
  candidatesPacked: number;
  candidatesCompressed: number;
  candidatesEvicted: number;
  /**
   * How many retrieval engines (or the pinned-record query) rejected during
   * compile. 0 on a clean run. A non-zero value means context was degraded —
   * dropped candidates or, worst case, dropped salience-1.0 procedural rules.
   */
  retrievalFailures: number;
}

export interface LayoutInput {
  /** Included records at full text. */
  included: MemoryRecord[];
  /** Compressed items. */
  compressed: CompressedItem[];
  /** Pinned procedural records. */
  pinned: MemoryRecord[];
  /** System prompt text. */
  systemPrompt: string;
  /** Model ID for token counting. */
  modelId: string;
  /** Token usage from packer. */
  tokenUsage: TokenUsage;
  /** Compile timing metadata. */
  metadata: CompileMetadata;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Build the context window layout from packed results.
 */
export function buildLayout(input: LayoutInput): ContextWindow {
  const sections: ContextSection[] = [];
  const { included, compressed, pinned, systemPrompt, modelId, tokenUsage, metadata } = input;

  // Section 0: System prompt (always stable)
  if (systemPrompt) {
    sections.push(makeSection("system", "system-prompt", systemPrompt, modelId));
  }

  // Section 1: Procedural rules (stable — sorted by ID for determinism)
  if (pinned.length > 0) {
    const sortedPinned = [...pinned].sort((a, b) => a.id.localeCompare(b.id));
    const content = sortedPinned
      .map((r) => {
        const body = r.body as Record<string, unknown>;
        return body.rule ?? JSON.stringify(body);
      })
      .join("\n\n");
    sections.push(makeSection("procedural", "pinned-rules", String(content), modelId));
  }

  // Section 2: Project facts (stable — semantic records sorted by ID)
  const semanticRecords = included.filter((r) => r.kind === "semantic");
  if (semanticRecords.length > 0) {
    const sorted = [...semanticRecords].sort((a, b) => a.id.localeCompare(b.id));
    const content = sorted
      .map((r) => (r.body as Record<string, unknown>).fact ?? JSON.stringify(r.body))
      .join("\n");
    sections.push(makeSection("project-facts", "semantic-facts", String(content), modelId));
  }

  // Section 4: Retrieved content (volatile — order by score, already sorted)
  const retrievedRecords = included.filter((r) => r.kind !== "semantic" && !pinned.some((p) => p.id === r.id));
  if (retrievedRecords.length > 0) {
    const content = retrievedRecords
      .map((r) => formatRecordForContext(r))
      .join("\n\n");
    sections.push(makeSection("retrieved", "retrieved-memories", content, modelId));
  }

  // Section 5: Compressed items (volatile)
  if (compressed.length > 0) {
    const content = compressed
      .map((c) => `• ${c.summary} [ref:${c.recordId.slice(0, 8)}]`)
      .join("\n");
    sections.push(makeSection("compressed", "compressed-refs", content, modelId));
  }

  // Sort sections by position
  sections.sort((a, b) => a.position - b.position);

  // Compute cache prefix metrics
  const stableBytes = sections
    .filter((s) => s.stable)
    .reduce((sum, s) => sum + s.content.length, 0);
  const totalBytes = sections.reduce((sum, s) => sum + s.content.length, 0);

  return {
    sections,
    tokenUsage,
    cachePrefix: {
      stableBytes,
      totalBytes,
      hitRate: totalBytes > 0 ? stableBytes / totalBytes : 0,
    },
    metadata,
  };
}

function makeSection(type: SectionType, id: string, content: string, modelId: string): ContextSection {
  return {
    id,
    type,
    content,
    tokens: countTokens(content, modelId),
    stable: SECTION_STABILITY[type],
    position: SECTION_POSITIONS[type],
  };
}

function formatRecordForContext(record: MemoryRecord): string {
  const body = record.body as Record<string, unknown>;
  switch (record.kind) {
    case "episodic": {
      const event = body.event ?? "event";
      const outcome = body.outcome ? ` [${body.outcome}]` : "";
      const payload = body.payload;
      const detail = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
      return `${event}${outcome}: ${detail}`.slice(0, 500);
    }
    case "procedural":
      return String(body.rule ?? JSON.stringify(body));
    case "entity":
      return `${body.entityType}: ${body.name}`;
    case "edge":
      return `${body.edgeType}: ${body.sourceId} → ${body.targetId}`;
    default:
      return JSON.stringify(body).slice(0, 500);
  }
}
