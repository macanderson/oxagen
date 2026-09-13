/**
 * to-sentence-case.ts — converts a Title Case label (the suggested-prompt
 * bank's stable contract, see `page-context/suggested-prompts.ts`) to sentence
 * case for chat_ux_v2 display: "Continue The Thread" → "Continue the thread".
 *
 * A word keeps its original casing (isn't lowercased) when it:
 *   - is an acronym (2+ consecutive uppercase letters, e.g. "CI", "MCP"),
 *   - contains a digit (e.g. "Q4"),
 *   - contains a quote or backtick character, or
 *   - is the pronoun "I" (or an "I'm"/"I'll"/"I've"/"I'd" contraction) —
 *     English always capitalizes it regardless of sentence position.
 *
 * Only the label shown on a chip/button is passed through this — never the
 * full `prompt` text sent to the agent.
 */

const ACRONYM_RE = /[A-Z]{2,}/;
const DIGIT_RE = /[0-9]/;
const QUOTE_RE = /["'`]/;
const PRONOUN_I_RE = /^I(['’](m|ll|ve|d))?$/;

function stripTrailingPunctuation(word: string): string {
  return word.replace(/[.,!?;:]+$/, "");
}

function shouldPreserveCase(word: string): boolean {
  if (ACRONYM_RE.test(word) || DIGIT_RE.test(word) || QUOTE_RE.test(word)) {
    return true;
  }
  return PRONOUN_I_RE.test(stripTrailingPunctuation(word));
}

/**
 * Sentence-case a Title Case label: the first word is capitalized, every
 * later word is lowercased unless `shouldPreserveCase` exempts it.
 */
export function toSentenceCase(label: string): string {
  if (!label) return label;
  return label
    .split(" ")
    .map((word, index) => {
      if (word.length === 0) return word;
      if (shouldPreserveCase(word)) return word;
      const lower = word.toLowerCase();
      return index === 0
        ? lower.charAt(0).toUpperCase() + lower.slice(1)
        : lower;
    })
    .join(" ");
}
