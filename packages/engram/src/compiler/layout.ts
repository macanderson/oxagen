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
    /**
     * `stableBytes / totalBytes` — the share of the window that sits in
     * prefix-stable sections, i.e. the best cache hit rate this layout could
     * achieve. It is a property of the layout, not an observed cache result;
     * nothing here talks to a provider's prompt cache.
     */
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
  /**
   * How many pinned procedural rules the packer dropped because the pinned set
   * exceeded the budget (lowest-salience first). 0 normally.
   */
  pinnedTruncated: number;
  /**
   * How many included records had their rendered text truncated to fit the
   * per-record token allowance during layout. 0 when everything rendered in
   * full.
   */
  contentTruncated: number;
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
  /**
   * How many pinned rules the packer truncated (surfaced into metadata).
   */
  pinnedTruncated?: number;
  /**
   * Per-record token allowance for the retrieved section. A record whose
   * rendered text exceeds this is truncated on a token boundary (not the old
   * hard 500-char slice, which cut token-dense code mid-budget). Default: 500
   * tokens.
   */
  maxRecordTokens?: number;
}

/** Default per-record token allowance for rendered retrieved content. */
const DEFAULT_MAX_RECORD_TOKENS = 500;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Build the context window layout from packed results.
 */
export function buildLayout(input: LayoutInput): ContextWindow {
  const sections: ContextSection[] = [];
  const {
    included,
    compressed,
    pinned,
    systemPrompt,
    modelId,
    tokenUsage,
    metadata,
  } = input;
  const maxRecordTokens = input.maxRecordTokens ?? DEFAULT_MAX_RECORD_TOKENS;
  let contentTruncated = 0;

  // Section 0: System prompt (always stable)
  if (systemPrompt) {
    sections.push(
      makeSection("system", "system-prompt", systemPrompt, modelId),
    );
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
    sections.push(
      makeSection("procedural", "pinned-rules", String(content), modelId),
    );
  }

  // Section 2: Project facts (stable — semantic records sorted by ID)
  const semanticRecords = included.filter((r) => r.kind === "semantic");
  if (semanticRecords.length > 0) {
    const sorted = [...semanticRecords].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const content = sorted
      .map(
        (r) =>
          (r.body as Record<string, unknown>).fact ?? JSON.stringify(r.body),
      )
      .join("\n");
    sections.push(
      makeSection("project-facts", "semantic-facts", String(content), modelId),
    );
  }

  // Section 4: Retrieved content (volatile — order by score, already sorted)
  const retrievedRecords = included.filter(
    (r) => r.kind !== "semantic" && !pinned.some((p) => p.id === r.id),
  );
  if (retrievedRecords.length > 0) {
    const content = retrievedRecords
      .map((r) => {
        const rendered = formatRecordForContext(r);
        const { text, truncated } = truncateToTokens(
          rendered,
          maxRecordTokens,
          modelId,
        );
        if (truncated) contentTruncated += 1;
        return text;
      })
      .join("\n\n");
    sections.push(
      makeSection("retrieved", "retrieved-memories", content, modelId),
    );
  }

  // Section 5: Compressed items (volatile)
  if (compressed.length > 0) {
    const content = compressed
      .map((c) => `• ${c.summary} [ref:${c.recordId.slice(0, 8)}]`)
      .join("\n");
    sections.push(
      makeSection("compressed", "compressed-refs", content, modelId),
    );
  }

  // Sort sections by position
  sections.sort((a, b) => a.position - b.position);

  // Compute cache prefix metrics
  const stableBytes = sections
    .filter((s) => s.stable)
    .reduce((sum, s) => sum + s.content.length, 0);
  const totalBytes = sections.reduce((sum, s) => sum + s.content.length, 0);

  // Surface truncation counts into metadata so a caller can see when context
  // was degraded (pinned rules dropped by the packer, or record bodies trimmed
  // to their token allowance here).
  metadata.pinnedTruncated =
    input.pinnedTruncated ?? metadata.pinnedTruncated ?? 0;
  metadata.contentTruncated = contentTruncated;

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

/**
 * Truncate `text` so its token count under `modelId` does not exceed
 * `maxTokens`. Binary-searches the longest character prefix that fits, then
 * appends an ellipsis marker. Returns whether truncation occurred so the
 * caller can record it. O(log n) tokenizer calls.
 */
function truncateToTokens(
  text: string,
  maxTokens: number,
  modelId: string,
): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: "", truncated: text.length > 0 };
  if (countTokens(text, modelId) <= maxTokens)
    return { text, truncated: false };

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (countTokens(text.slice(0, mid), modelId) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return { text: `${text.slice(0, lo).trimEnd()}…`, truncated: true };
}

function makeSection(
  type: SectionType,
  id: string,
  content: string,
  modelId: string,
): ContextSection {
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
      const detail =
        typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
      // Full text — the caller truncates by token allowance, not a hard char slice.
      return `${event}${outcome}: ${detail}`;
    }
    case "procedural":
      return String(body.rule ?? JSON.stringify(body));
    case "entity":
      return `${body.entityType}: ${body.name}`;
    case "edge":
      return `${body.edgeType}: ${body.sourceId} → ${body.targetId}`;
    default:
      return JSON.stringify(body);
  }
}
