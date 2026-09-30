// The label rule (CLAUDE.md, Labels and headings; ADR-226, amendment of
// 2026-09-29) as a check over the message catalogues. label-voice.test.ts runs
// it over messages/*.json. It uses only erasable TypeScript and imports
// nothing, so a plain `node` script can load it too.

/** One catalogue leaf: its dotted key and its string value. */
export type Leaf = { readonly key: string; readonly value: string };

/** Which part of the rule a label breaks. */
export type Shape =
  | "heading-punctuation"
  | "heading-phrase"
  | "caption-punctuation"
  | "question-label"
  | "pronoun-label"
  | "contrast-label"
  | "semicolon-label"
  | "em-dash";

export type Finding = Leaf & { readonly shape: Shape };

/** A key whose value is drawn as a heading, a panel or dialog title, a column head, or a tab. */
const HEADING_KEY =
  /(?:^|\.)(?:title|heading|eyebrow|[a-z][A-Za-z]*(?:Title|Heading|Eyebrow))$|\.(?:columns|[a-z][A-Za-z]*Columns|tabs)\.[^.]+$/;

/** A key whose value is drawn as a tile note, a caption, a badge, a hint, or a subtitle. */
const CAPTION_KEY =
  /(?:^|\.)(?:note|caption|badge|hint|sub|subtitle|[a-z][A-Za-z]*(?:Note|Caption|Badge|Hint))$/;

/** A comma, mid-dot, semicolon, dash, or exclamation point: two ideas where a label holds one. */
const HEADING_PUNCTUATION = /[·,;—–!]/;
const CAPTION_PUNCTUATION = /[·,;—–]/;

/** A question phrase or a slogan where a heading names the thing: "Who receives it", "Everything written down". */
const PHRASE_START = /^(?:who|what|where|why|how|everything)\b/i;

/**
 * A verb whose object is a pronoun: "Read them", "Wrap it", "Keep it linked".
 * A button or a tab names what it acts on.
 */
const PRONOUN_LABEL = /^\p{Lu}\p{Ll}+ (?:it|them)\b/u;

/** A "not" or "never" contrast after a comma: "ordered by the frames, not by kind", "subagents narrow, never widen". */
const CONTRAST = /,\s*(?:not|never)\b/i;

/** An em dash anywhere in a string, a sentence included (clear-prose, rule 1). */
const EM_DASH = /—/;

/** The glyph a table draws in an empty cell. It is not a dash in prose. */
const EMPTY_CELL = "—";

/** The longest short label, in words, that the question and pronoun checks read. */
const SHORT_LABEL_WORDS = 6;

/** Every string leaf of a nested catalogue, keyed by its dotted path. */
export function leaves(messages: unknown, trail = ""): Leaf[] {
  if (typeof messages === "string") return [{ key: trail, value: messages }];
  if (typeof messages !== "object" || messages === null) return [];
  return Object.entries(messages).flatMap(([key, value]) =>
    leaves(value, trail ? `${trail}.${key}` : key),
  );
}

/**
 * The words a person reads: rich-text tags dropped, and every ICU argument,
 * a plural included, collapsed to one placeholder word, so a comma inside
 * `{count, plural, …}` is not read as the label's own.
 */
export function visibleText(value: string): string {
  let text = value.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(/\{[^{}]*\}/g, "X");
  }
  return text.trim();
}

/**
 * The parts of the rule one leaf breaks. A value that ends in a period is a
 * sentence, not a label, so only the em-dash check reads it. The contrast and
 * semicolon checks read every other value, whatever its key, because a table
 * cell or a field value is read as a label too.
 */
export function shapesOf({ key, value }: Leaf): Shape[] {
  if (value.trim() === EMPTY_CELL) return [];
  const shapes: Shape[] = [];
  if (EM_DASH.test(value)) shapes.push("em-dash");
  const text = visibleText(value);
  if (text.endsWith(".")) return shapes;
  const heading = HEADING_KEY.test(key);
  const caption = CAPTION_KEY.test(key);
  if (heading && HEADING_PUNCTUATION.test(text)) {
    shapes.push("heading-punctuation");
  }
  if (heading && PHRASE_START.test(text)) shapes.push("heading-phrase");
  if (caption && CAPTION_PUNCTUATION.test(text)) {
    shapes.push("caption-punctuation");
  }
  if (!heading && !caption) {
    if (CONTRAST.test(text)) shapes.push("contrast-label");
    if (text.includes(";")) shapes.push("semicolon-label");
  }
  if (text.split(/\s+/).length <= SHORT_LABEL_WORDS) {
    if (!heading && PHRASE_START.test(text)) shapes.push("question-label");
    if (PRONOUN_LABEL.test(text)) shapes.push("pronoun-label");
  }
  return shapes;
}

/** Every leaf that breaks the rule, once per shape it breaks. */
export function labelFindings(all: readonly Leaf[]): Finding[] {
  return all.flatMap((leaf) =>
    shapesOf(leaf).map((shape) => ({ ...leaf, shape })),
  );
}
