/**
 * intent-router.ts — classify a query into one of four intent categories.
 *
 * Intent types:
 *   Navigate — matches a known nav target from enumerateNavTargets
 *   Search   — looks like a search query (who/what/where/list/find)
 *   Action   — imperative verb targeting an in-product action
 *   Ask      — default: open the ask drawer with the query as seed text
 *
 * Resolution order:
 *   1. If the text matches a nav target (fuzzy, first-match) → Navigate
 *   2. If the text begins with a question/search term → Search
 *   3. If the text is an imperative action phrase → Action
 *   4. Default → Ask
 *
 * ADR-041 retired the fifth category (Fill): it dispatched the `form.fill`
 * capability, which went with the runtime.
 *
 * No external dependencies — pure functions that work in any context.
 */

import { enumerateNavTargets } from "@/lib/sidebar";
import type { ScopeContext } from "@/lib/scope";

// ---------------------------------------------------------------------------
// Intent types
// ---------------------------------------------------------------------------

export type IntentNavigate = {
  type: "navigate";
  href: string;
  label: string;
};

export type IntentSearch = {
  type: "search";
  query: string;
};

export type IntentAction = {
  type: "action";
  verb: string;
  query: string;
};

export type IntentAsk = {
  type: "ask";
  query: string;
};

export type Intent = IntentNavigate | IntentSearch | IntentAction | IntentAsk;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise text for matching — lowercase, collapse whitespace, strip punctuation. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fuzzy match: does `needle` appear in `haystack` after normalisation? */
function fuzzyMatch(needle: string, haystack: string): boolean {
  const n = normalise(needle);
  const h = normalise(haystack);
  if (h.includes(n)) return true;
  // Token-level partial: every normalised word in needle appears in haystack
  const tokens = n.split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => h.includes(t));
}

// Prefixes that signal the user wants to navigate somewhere.
const NAV_PREFIXES = [
  "go to",
  "open",
  "navigate to",
  "take me to",
  "show me",
  "go",
];

// Prefixes that signal a question / search.
const SEARCH_PREFIXES = [
  "who",
  "what",
  "where",
  "when",
  "why",
  "how",
  "list",
  "find",
  "search",
  "show",
  "display",
  "get",
  "which",
  "is there",
  "are there",
];

// Imperative action verbs.
const ACTION_VERBS = [
  "create",
  "new",
  "add",
  "delete",
  "remove",
  "archive",
  "invite",
  "connect",
  "disconnect",
  "deploy",
  "publish",
  "save",
  "run",
];

/** True when the query text looks like a question or search. */
function looksLikeSearch(text: string): boolean {
  const n = normalise(text);
  return SEARCH_PREFIXES.some((p) => n.startsWith(p));
}

/** True when the query text is an imperative action. */
function looksLikeAction(text: string): boolean {
  const n = normalise(text);
  return ACTION_VERBS.some((v) => n.startsWith(v));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ClassifyOptions {
  /** The raw input query from the user. */
  query: string;
  /** The current scope context — used to enumerate nav targets. */
  ctx: ScopeContext;
}

/**
 * Classify a query into an Intent.
 *
 * @pure — no side effects, no async.
 */
export function classifyIntent(options: ClassifyOptions): Intent {
  const { query, ctx } = options;
  const trimmed = query.trim();
  if (!trimmed) return { type: "ask", query: trimmed };

  const n = normalise(trimmed);

  // 1. Navigate: strip nav prefixes and fuzzy-match against known targets.
  // Always attempt nav match — not gated on prefix, short exact labels match well.
  {
    // Find the first matching prefix and strip it once; do NOT reduce through
    // all prefixes — "go to" and "go" overlap and a second pass would corrupt
    // the remainder (e.g. "go to Knowledge" → "to Knowledge" on the "go" pass).
    const matchedPrefix = NAV_PREFIXES.find((p) => n.startsWith(p + " "));
    const stripped = matchedPrefix
      ? trimmed.slice(matchedPrefix.length + 1).trim()
      : trimmed;

    const targets = enumerateNavTargets(ctx);
    const match = targets.find(
      (t) => fuzzyMatch(stripped, t.label) || fuzzyMatch(trimmed, t.label),
    );
    if (match) {
      return { type: "navigate", href: match.href, label: match.label };
    }
  }

  // 2. Search.
  if (looksLikeSearch(trimmed)) {
    return { type: "search", query: trimmed };
  }

  // 3. Action.
  if (looksLikeAction(trimmed)) {
    const verb = ACTION_VERBS.find((v) => n.startsWith(v)) ?? "action";
    return { type: "action", verb, query: trimmed };
  }

  // 4. Default: Ask.
  return { type: "ask", query: trimmed };
}
