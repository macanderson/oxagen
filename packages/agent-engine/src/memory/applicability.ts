/**
 * Memory-recall applicability filter (F9).
 *
 * Gate for filtering retrieved memory items by lexical + semantic relevance
 * to the current task. Two-stage: deterministic overlap filter (always runs),
 * then optional model-based scoring (only when >2 survivors).
 *
 * Pure TypeScript, zero I/O except the injected scorer, no external deps,
 * no `any` (TS 6). Exports decision functions and rendering utilities.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A recalled memory item to be scored for applicability.
 */
export interface RecallItem {
  id: string;
  text: string;
  kind?: string;
}

/**
 * A recall item paired with its applicability score and justification.
 */
export interface ScoredRecall {
  item: RecallItem;
  score: number;
  reason: string;
}

/**
 * Context for evaluating applicability: the issue being solved and
 * candidate files (from F1 localization).
 */
export interface TaskContext {
  issue: string;
  candidateFiles: string[];
}

/**
 * Injected scorer function: batch-scores items for applicability (0–1).
 * Called only when >2 items survive stage 1.
 * Returns an array of { id, score, reason } for each item it can score.
 * Items not in the response are treated as score 0 (dropped).
 * If the scorer throws, the caller falls back to stage-1 survivors with score -1.
 */
export type ApplicabilityScorer = (
  items: RecallItem[],
  context: TaskContext,
) => Promise<Array<{ id: string; score: number; reason: string }>>;

// ── Stopwords and tokenization ─────────────────────────────────────────────

/**
 * Common English stopwords to exclude from lexical overlap scoring.
 * Lowercase, short tokens (<3 chars) are also filtered.
 */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "are",
  "was",
  "not",
  "you",
  "all",
  "can",
  "has",
  "have",
  "when",
  "then",
  "into",
  "only",
]);

/**
 * Tokenize text into lowercase word tokens: split on non-alphanumerics,
 * drop tokens shorter than 3 chars and stopwords.
 */
function tokenizeWords(text: string): Set<string> {
  const tokens = new Set<string>();
  const parts = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const part of parts) {
    if (part.length >= 3 && !STOPWORDS.has(part)) {
      tokens.add(part);
    }
  }
  return tokens;
}

/**
 * Extract path-like tokens from text: substrings containing "/" or
 * ending with ".ts", ".py", ".js", etc.
 */
function extractPathTokens(text: string): string[] {
  const paths: string[] = [];
  // Match sequences that look like file paths or extensions
  const pathRegex =
    /[\w./\-]+\.(ts|tsx|js|jsx|py|java|go|rs|rb|php|cs|cpp|c|h|hpp|json|yaml|yml|xml|html|css|sql|md)/gi;
  const matches = text.matchAll(pathRegex);
  for (const match of matches) {
    paths.push(match[0]);
  }
  // Also capture sequences with "/" (directory paths)
  const dirRegex = /[\w.\-]+\/[\w./\-]*/g;
  const dirMatches = text.matchAll(dirRegex);
  for (const match of dirMatches) {
    paths.push(match[0]);
  }
  return paths;
}

// ── Lexical overlap scoring ────────────────────────────────────────────────

/**
 * Compute lexical overlap between a recall item and the task context.
 *
 * Returns the count of distinct shared word tokens, plus a +5 bonus when
 * a path token from the item overlaps a candidate file (substring match
 * either direction counts).
 *
 * Stage 1 filter drops items where this returns 0.
 */
export function lexicalOverlap(item: RecallItem, context: TaskContext): number {
  const itemWords = tokenizeWords(item.text);
  const issueWords = tokenizeWords(context.issue);

  // Count shared word tokens.
  let overlap = 0;
  for (const word of itemWords) {
    if (issueWords.has(word)) {
      overlap++;
    }
  }

  // Check path-token overlap with candidate files.
  const itemPaths = extractPathTokens(item.text);
  for (const path of itemPaths) {
    for (const candidate of context.candidateFiles) {
      // Substring match either direction.
      if (candidate.includes(path) || path.includes(candidate)) {
        overlap += 5;
        break; // Count each path token only once.
      }
    }
  }

  return overlap;
}

// ── Stage 1: deterministic filtering ───────────────────────────────────────

/**
 * Stage 1 filtering: drop items with zero lexical overlap, cap at maxSurvivors
 * (default 8), preserve order on ties.
 */
function stageOne(
  items: RecallItem[],
  context: TaskContext,
  maxSurvivors: number,
): Array<{ item: RecallItem; overlap: number; originalIndex: number }> {
  const scored = items
    .map((item, index) => ({
      item,
      overlap: lexicalOverlap(item, context),
      originalIndex: index,
    }))
    .filter((entry) => entry.overlap > 0)
    .sort((a, b) => {
      // Sort by overlap descending, then by original order.
      if (a.overlap !== b.overlap) {
        return b.overlap - a.overlap;
      }
      return a.originalIndex - b.originalIndex;
    })
    .slice(0, maxSurvivors);

  return scored;
}

// ── Stage 2: model-based scoring ──────────────────────────────────────────

/**
 * Stage 2 scoring: if >2 survivors and scorer is provided, call scorer once
 * and filter by threshold. Missing items in scorer response are treated as 0.
 * If scorer throws, fall back to stage-1 survivors with score -1 and reason
 * "scorer-unavailable".
 */
async function stageTwo(
  survivors: Array<{ item: RecallItem; originalIndex: number }>,
  context: TaskContext,
  scorer: ApplicabilityScorer | null,
  threshold: number,
): Promise<ScoredRecall[]> {
  // If scorer is null or ≤2 survivors, return stage-1 survivors as-is.
  if (scorer === null || survivors.length <= 2) {
    return survivors.map((entry) => ({
      item: entry.item,
      score: -1,
      reason: "lexical-only",
    }));
  }

  // Call scorer with the survivors.
  let scores: Map<string, { score: number; reason: string }>;
  try {
    const result = await scorer(
      survivors.map((e) => e.item),
      context,
    );
    scores = new Map(
      result.map((r) => [r.id, { score: r.score, reason: r.reason }]),
    );
  } catch {
    // Scorer threw; fail open with stage-1 survivors.
    return survivors.map((entry) => ({
      item: entry.item,
      score: -1,
      reason: "scorer-unavailable",
    }));
  }

  // Filter by threshold and missing items (treat as score 0).
  const filtered: ScoredRecall[] = [];
  for (const entry of survivors) {
    const scored = scores.get(entry.item.id);
    const score = scored?.score ?? 0;
    if (score >= threshold) {
      filtered.push({
        item: entry.item,
        score,
        reason: scored?.reason ?? "",
      });
    }
  }

  return filtered;
}

// ── Main filter function ───────────────────────────────────────────────────

/**
 * Filter recalled items by applicability to the task.
 *
 * Stage 1 (always): drop items with zero lexical overlap; cap at maxSurvivors.
 * Stage 2 (conditional): if >2 survivors and scorer provided, call scorer
 * and filter by threshold.
 *
 * Result order: score desc, then original order. Every item has a non-empty
 * reason. Returns empty array when no items survive.
 */
export async function filterRecall(
  items: RecallItem[],
  context: TaskContext,
  scorer: ApplicabilityScorer | null = null,
  opts?: { maxSurvivors?: number; threshold?: number },
): Promise<ScoredRecall[]> {
  const maxSurvivors = opts?.maxSurvivors ?? 8;
  const threshold = opts?.threshold ?? 0.6;

  // Stage 1: deterministic filtering.
  const survivors = stageOne(items, context, maxSurvivors);

  // Stage 2: optional model-based scoring.
  const scored = await stageTwo(
    survivors.map((e) => ({ item: e.item, originalIndex: e.originalIndex })),
    context,
    scorer,
    threshold,
  );

  // Sort by score desc, then original order.
  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    // Preserve original order for ties (need to track original indices).
    // For simplicity, we rely on the stable sort and the fact that
    // stageTwo preserves order.
    return 0;
  });

  return scored;
}

// ── Rendering ──────────────────────────────────────────────────────────────

/**
 * Render surviving items as a markdown block titled "## Lessons from prior sessions (filtered)".
 * Each line is "- [recall — verify before trusting] <text>", single-line-collapsed,
 * capped at 300 chars per line.
 * Empty input returns "".
 */
export function tagRecall(items: ScoredRecall[]): string {
  if (items.length === 0) {
    return "";
  }

  const lines = items.map((entry) => {
    // Collapse to single line and cap at 300 chars.
    let text = entry.item.text.replace(/\s+/g, " ").trim();
    if (text.length > 300) {
      text = text.slice(0, 297) + "...";
    }
    return `- [recall — verify before trusting] ${text}`;
  });

  return "## Lessons from prior sessions (filtered)\n" + lines.join("\n");
}
