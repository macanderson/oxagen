/**
 * Query tokenizer for `EpisodicStore.searchLexical()`. Lives outside the DuckDB
 * adapter so any future store adapter scores matches the same way.
 *
 * Splits on whitespace/punctuation but keeps `.`, `/`, `:`, `_`, `-` glued to
 * adjacent alphanumerics so file paths (`auth.ts`), stack frames
 * (`auth.ts:42`), and identifiers (`null_pointer_exception`) survive as a
 * single token instead of being shredded — these are exactly the exact-match
 * cases lexical recall exists for.
 */

/** Hard cap on tokens per query so a pathological input can't blow up the SQL. */
export const MAX_LEXICAL_TOKENS = 16;

/** Minimum token length — single characters are too noisy to score on. */
const MIN_TOKEN_LENGTH = 2;

/**
 * Tokenize `text` into lowercased, deduplicated search terms.
 * Returns at most `MAX_LEXICAL_TOKENS` tokens, longest-first (longer tokens
 * tend to be more specific — file paths, identifiers — so they're kept over
 * generic short words when the cap trims the list).
 *
 * ASCII-only: the split class keeps `[a-z0-9_./:-]`, so a query written wholly
 * in a non-Latin script tokenizes to nothing and `searchLexical` returns no
 * rows. Lexical recall is an exact-identifier mechanism, so that is the
 * intended floor rather than a silent partial match — but it does mean lexical
 * retrieval contributes nothing for such a query.
 */
export function tokenizeLexicalQuery(text: string): string[] {
  const raw = text
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/i)
    .map((t) => t.replace(/^[./:_-]+|[./:_-]+$/g, ""))
    .filter((t) => t.length >= MIN_TOKEN_LENGTH);

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const token of raw) {
    if (!seen.has(token)) {
      seen.add(token);
      deduped.push(token);
    }
  }

  return deduped
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_LEXICAL_TOKENS);
}
