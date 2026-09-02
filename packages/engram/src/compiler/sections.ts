/**
 * Section type definitions for the context window layout.
 */

export type SectionType =
  | "system" // Position 0 — system prompt (always stable)
  | "procedural" // Position 1 — pinned rules (mostly stable)
  | "project-facts" // Position 2 — semantic memory (semi-stable)
  | "code-skeleton" // Position 3 — code graph context (semi-stable)
  | "retrieved" // Position 4 — task-specific retrieved (volatile)
  | "compressed" // Position 5 — compressed items with handles (volatile)
  | "tool-results" // Position 6 — recent tool outputs (volatile)
  | "working"; // Position 7 — working memory / scratchpad (volatile)

export interface ContextSection {
  id: string;
  type: SectionType;
  content: string;
  tokens: number;
  /** true = doesn't change between turns (prefix-safe). */
  stable: boolean;
  /** Ordering rank (lower = earlier in prompt). */
  position: number;
}

/** Position ordering for each section type. */
export const SECTION_POSITIONS: Record<SectionType, number> = {
  system: 0,
  procedural: 1,
  "project-facts": 2,
  "code-skeleton": 3,
  retrieved: 4,
  compressed: 5,
  "tool-results": 6,
  working: 7,
};

/** Whether each section type is stable (cache-safe). */
export const SECTION_STABILITY: Record<SectionType, boolean> = {
  system: true,
  procedural: true,
  "project-facts": true,
  "code-skeleton": false,
  retrieved: false,
  compressed: false,
  "tool-results": false,
  working: false,
};
