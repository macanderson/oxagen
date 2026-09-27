// How the memory pipeline compares statements (ADR-206).
//
// Two statements are compared by their words, not their meaning. A person
// reviews every record the curator proposes, so a duplicate the test misses
// costs a reviewer one extra record, and an embedding would bill every memory
// and every record every day.
import { createHash } from "node:crypto";

/**
 * A statement as the duplicate test and the rejection hash read it:
 * lowercase, apostrophes dropped (so "don't" reads "dont"), every other run
 * of punctuation turned to a space, and whitespace collapsed.
 */
export function normalizeStatement(statement: string): string {
  return statement
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['‘’ʼ]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The sha256 of the normalized statement, in hex: the key a rejection matches. */
export function statementHash(statement: string): string {
  return createHash("sha256")
    .update(normalizeStatement(statement), "utf8")
    .digest("hex");
}

/** Words that carry no lesson on their own. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "always",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "before",
  "by",
  "can",
  "could",
  "do",
  "does",
  "each",
  "every",
  "for",
  "from",
  "had",
  "has",
  "have",
  "here",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "may",
  "might",
  "must",
  "of",
  "on",
  "only",
  "or",
  "our",
  "should",
  "so",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "use",
  "used",
  "using",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

/** Words that turn a lesson around. "no longer" is matched as a pair. */
const NEGATIONS: ReadonlySet<string> = new Set([
  "never",
  "not",
  "avoid",
  "stop",
  "dont",
  "doesnt",
  "didnt",
  "isnt",
  "arent",
  "wasnt",
  "cant",
  "cannot",
  "wont",
  "shouldnt",
  "mustnt",
]);

/** A word as the comparisons count it: a trailing plural `s` is dropped. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
    ? word.slice(0, -1)
    : word;
}

/** A statement read for comparison: its content words, and whether it negates. */
export interface StatementWords {
  /** Content words, stemmed, with stopwords and negations left out. */
  words: ReadonlySet<string>;
  /** True when the statement says never, not, avoid, stop, or no longer. */
  negated: boolean;
}

/** Read a statement's content words and its polarity. */
export function statementWords(statement: string): StatementWords {
  const tokens = normalizeStatement(statement).split(" ").filter(Boolean);
  const words = new Set<string>();
  let negated = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === "no" && tokens[i + 1] === "longer") {
      negated = true;
      i += 1;
      continue;
    }
    if (NEGATIONS.has(token)) {
      negated = true;
      continue;
    }
    if (STOPWORDS.has(token) || token === "no") continue;
    words.add(stem(token));
  }
  return { words, negated };
}

/** The share of words two sets hold in common: |A ∩ B| / |A ∪ B|, 0 when both are empty. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Word overlap at or above which two statements say the same thing. */
export const SAYS_SAME_MIN = 0.8;

/** Word overlap at or above which opposite statements contradict. */
export const CONTRADICTS_MIN = 0.5;

/** Do two statements say the same thing? Their words overlap by 80% and neither turns it around alone. */
export function saysSame(a: string, b: string): boolean {
  const left = statementWords(a);
  const right = statementWords(b);
  return (
    left.negated === right.negated &&
    jaccard(left.words, right.words) >= SAYS_SAME_MIN
  );
}

/** Does one statement contradict the other? Their words overlap by half, and exactly one negates. */
export function contradicts(a: string, b: string): boolean {
  const left = statementWords(a);
  const right = statementWords(b);
  return (
    left.negated !== right.negated &&
    jaccard(left.words, right.words) >= CONTRADICTS_MIN
  );
}
