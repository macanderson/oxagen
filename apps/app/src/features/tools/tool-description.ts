// A tool's description split into what a person reads and the worked examples
// the provider wrote for the model.
//
// Providers put examples inline as `<example description="…">{…}</example>`
// (Notion's MCP tools do, several per tool). Left in place they run into the
// prose as one paragraph of JSON. Pulled out, each renders as its own titled
// code block, and the prose renders as markdown without them.
//
// Nothing is dropped: a body that is not JSON is kept as written, and a tag
// this file does not know stays in the prose, where it renders as text.

interface ToolExample {
  /** The tag's `description` attribute, or null when it has none. */
  title: string | null;
  /** Pretty-printed when it parses as JSON, the source as written otherwise. */
  body: string;
  language: "json" | "text";
}

export interface ToolDescription {
  prose: string;
  examples: ToolExample[];
}

/** A whole attribute, so `data-description` is not read as the title. */
const TITLE = /(?:^|\s)description\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
/** The `<examples>` wrapper some providers put round the list, now empty. */
const WRAPPER = /<\/?examples\b[^>]*>/gi;
/** Three or more line breaks, blank lines with spaces included. */
const BLANK_RUN = /\n(?:[ \t]*\n){2,}/g;

function example(attributes: string, raw: string): ToolExample {
  const match = TITLE.exec(attributes);
  const title = (match?.[1] ?? match?.[2] ?? "").trim() || null;
  const body = raw.trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      return { title, body: JSON.stringify(parsed, null, 2), language: "json" };
    }
  } catch {
    // Not valid JSON: providers write examples by hand and leave quotes
    // unescaped. The body is shown as written, coloured as JSON when it
    // opens like JSON, since the colours are a reading aid and never a check.
  }
  return { title, body, language: /^[[{]/.test(body) ? "json" : "text" };
}

/**
 * The index just past the `>` that ends a tag's attributes, or -1 when none
 * does. An attribute may quote a `>`, so a quoted value is skipped whole.
 */
function tagEnd(text: string, from: number): number {
  let quote: string | null = null;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index + 1;
    }
  }
  return -1;
}

/**
 * One pass, left to right. A regex with a lazy body rescans to the end of the
 * text from every opening tag that never closes, so a provider's description
 * of repeated unclosed tags took time that grew with the square of its length.
 * Here each character is read a fixed number of times. The first tag that
 * never closes ends the scan, and it and everything after it stay in the prose.
 */
export function splitToolDescription(text: string): ToolDescription {
  const examples: ToolExample[] = [];
  const kept: string[] = [];
  const open = /<example\b/gi;
  const close = /<\/example\s*>/gi;
  let cursor = 0;
  for (let tag = open.exec(text); tag !== null; tag = open.exec(text)) {
    const attributesStart = tag.index + tag[0].length;
    const bodyStart = tagEnd(text, attributesStart);
    if (bodyStart === -1) break;
    close.lastIndex = bodyStart;
    const end = close.exec(text);
    if (end === null) break;
    kept.push(text.slice(cursor, tag.index), "\n");
    examples.push(
      example(
        text.slice(attributesStart, bodyStart - 1),
        text.slice(bodyStart, end.index),
      ),
    );
    cursor = close.lastIndex;
    open.lastIndex = cursor;
  }
  kept.push(text.slice(cursor));
  const prose = kept
    .join("")
    .replace(WRAPPER, "")
    .replace(BLANK_RUN, "\n\n")
    .trim();
  return { prose, examples };
}
