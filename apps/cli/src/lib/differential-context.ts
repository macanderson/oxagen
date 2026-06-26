/**
 * Differential context tracking — computes and reports the delta between
 * consecutive compile() windows across turns.
 *
 * Shows what was added/removed/unchanged in the context window so the
 * developer can see exactly what the agent is working with each turn.
 */

export interface ContextDelta {
  /** Sections added this turn. */
  added: Array<{ type: string; tokens: number }>;
  /** Sections removed from previous turn. */
  removed: Array<{ type: string; tokens: number }>;
  /** Sections unchanged (cache-stable prefix). */
  unchanged: Array<{ type: string; tokens: number }>;
  /** Net token change. */
  netTokenDelta: number;
  /** Total tokens in current window. */
  currentTotal: number;
  /** Cache hit rate (unchanged / total). */
  cacheHitRate: number;
}

interface Section {
  id: string;
  type: string;
  tokens: number;
  content: string;
}

/**
 * Compute the delta between two context windows.
 */
export function computeDelta(
  previous: Section[] | null,
  current: Section[],
): ContextDelta {
  if (!previous) {
    // First turn — everything is "added"
    const added = current.map((s) => ({ type: s.type, tokens: s.tokens }));
    const currentTotal = current.reduce((sum, s) => sum + s.tokens, 0);
    return {
      added,
      removed: [],
      unchanged: [],
      netTokenDelta: currentTotal,
      currentTotal,
      cacheHitRate: 0,
    };
  }

  const previousIds = new Set(previous.map((s) => s.id));
  const currentIds = new Set(current.map((s) => s.id));

  const added: ContextDelta["added"] = [];
  const removed: ContextDelta["removed"] = [];
  const unchanged: ContextDelta["unchanged"] = [];

  // Find sections in current but not previous (added)
  for (const s of current) {
    if (!previousIds.has(s.id)) {
      added.push({ type: s.type, tokens: s.tokens });
    } else {
      // Check if content is the same
      const prev = previous.find((p) => p.id === s.id);
      if (prev && prev.content === s.content) {
        unchanged.push({ type: s.type, tokens: s.tokens });
      } else {
        // Modified — count as add + remove
        added.push({ type: s.type, tokens: s.tokens });
        if (prev) removed.push({ type: prev.type, tokens: prev.tokens });
      }
    }
  }

  // Find sections in previous but not current (removed)
  for (const s of previous) {
    if (!currentIds.has(s.id)) {
      removed.push({ type: s.type, tokens: s.tokens });
    }
  }

  const addedTokens = added.reduce((sum, s) => sum + s.tokens, 0);
  const removedTokens = removed.reduce((sum, s) => sum + s.tokens, 0);
  const unchangedTokens = unchanged.reduce((sum, s) => sum + s.tokens, 0);
  const currentTotal = current.reduce((sum, s) => sum + s.tokens, 0);

  return {
    added,
    removed,
    unchanged,
    netTokenDelta: addedTokens - removedTokens,
    currentTotal,
    cacheHitRate: currentTotal > 0 ? unchangedTokens / currentTotal : 0,
  };
}

/**
 * Format delta for display in the TUI.
 */
export function formatDelta(delta: ContextDelta): string {
  const parts: string[] = [];

  if (delta.added.length > 0) {
    const tokens = delta.added.reduce((s, a) => s + a.tokens, 0);
    parts.push(`+${delta.added.length} sections (+${tokens} tokens)`);
  }
  if (delta.removed.length > 0) {
    const tokens = delta.removed.reduce((s, r) => s + r.tokens, 0);
    parts.push(`-${delta.removed.length} sections (-${tokens} tokens)`);
  }
  if (delta.unchanged.length > 0) {
    parts.push(`${delta.unchanged.length} unchanged`);
  }

  parts.push(`Cache: ${Math.round(delta.cacheHitRate * 100)}%`);
  parts.push(`Net: ${delta.netTokenDelta >= 0 ? "+" : ""}${delta.netTokenDelta} tokens`);
  parts.push(`Total: ${delta.currentTotal} tokens`);

  return parts.join(" | ");
}
