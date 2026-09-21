// Text-only helpers shared by all creation wizards. Keep skill parsing out of this module.
/** Words a name never takes from a description (mockup `WZ_STOP`). */
const STOP = new Set([
  "the",
  "a",
  "an",
  "to",
  "for",
  "of",
  "and",
  "or",
  "in",
  "on",
  "our",
  "we",
  "i",
  "want",
  "need",
  "that",
  "with",
  "when",
  "from",
  "by",
  "it",
  "is",
  "be",
  "can",
  "should",
  "how",
  "new",
]);

/** The words of `text` a name may be built from, lowercased, in order. */
export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "" && !STOP.has(w));
}

/**
 * The load cost estimate: four characters a token, the estimate the handler
 * holds against the search budget (`estimateSkillTokens`). The real count is
 * the model's tokenizer, and the harness picks the model.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
