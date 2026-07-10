/**
 * Candidate mining shared by ENHANCE (evaluate/prompt-enhancer.ts) and F1
 * localization (localize/index.ts). Lives in internal/ as a leaf module —
 * both consumers import from here, so neither needs to import the other
 * (localize must stay a leaf; see its module docs).
 */

/** File extensions that mark a token as a path rather than prose. */
export const CODEY_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|sql|py|go|rs|sh|yml|yaml|toml)$/;

/**
 * Capitalized prose words that pattern-match the CamelCase symbol heuristic but
 * are almost never the symbol the user means. Mining them injects noise — e.g.
 * "Fix the validator" once resolved `Fix` to jquery's `fixInput` and burned
 * context tokens on irrelevant definitions. Lowercase comparison so `FIX`/`Fix`
 * both drop; real symbols like `FixDecimalInputMixin` are unaffected (full-token
 * match only).
 */
export const PROSE_STOPWORDS = new Set([
  "add",
  "added",
  "allow",
  "allows",
  "also",
  "and",
  "any",
  "are",
  "because",
  "before",
  "but",
  "can",
  "change",
  "changed",
  "confirm",
  "could",
  "create",
  "description",
  "does",
  "example",
  "expected",
  "fix",
  "fixed",
  "for",
  "from",
  "have",
  "here",
  "how",
  "however",
  "instead",
  "into",
  "issue",
  "make",
  "may",
  "must",
  "new",
  "not",
  "note",
  "now",
  "only",
  "please",
  "problem",
  "remove",
  "replace",
  "should",
  "since",
  "some",
  "support",
  "that",
  "the",
  "then",
  "there",
  "therefore",
  "this",
  "update",
  "use",
  "used",
  "using",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "would",
  "you",
]);

/**
 * Pull likely code references out of a natural-language prompt: backticked spans,
 * file paths, and identifier-shaped tokens (CamelCase / snake_case / dotted).
 */
export function extractCandidates(prompt: string): {
  symbols: string[];
  paths: string[];
} {
  const symbols = new Set<string>();
  const paths = new Set<string>();

  // Backticked spans are the strongest signal — the user is quoting code.
  for (const m of prompt.matchAll(/`([^`]+)`/g)) {
    const inner = (m[1] ?? "").trim();
    if (!inner) continue;
    if (inner.includes("/") || CODEY_EXT.test(inner)) paths.add(inner);
    else if (/^[\w.$]+$/.test(inner)) symbols.add(inner);
  }

  // Bare file paths and identifiers in the surrounding prose. Trailing
  // sentence punctuation is not part of the identifier — "ASCIIUsernameValidator."
  // at the end of a sentence must still mine the symbol.
  for (const m of prompt.matchAll(/[A-Za-z0-9_./-]+/g)) {
    const tok = m[0].replace(/[.]+$/, "");
    if (!tok) continue;
    if (CODEY_EXT.test(tok) || (tok.includes("/") && tok.length > 3)) {
      paths.add(tok.replace(/^\.\//, ""));
    } else if (
      (/^[A-Z][A-Za-z0-9]{2,}$/.test(tok) || /^[a-z]+_[a-z0-9_]+$/.test(tok)) &&
      !PROSE_STOPWORDS.has(tok.toLowerCase())
    ) {
      // CamelCase (Foo, GraphNode) or snake_case (build_tools) — likely symbols.
      symbols.add(tok);
    }
  }

  return { symbols: [...symbols], paths: [...paths] };
}
