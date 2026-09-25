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

export interface ToolExample {
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

/** An attribute list may quote a `>`, so quoted values are consumed whole. */
const EXAMPLE =
  /<example\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/example\s*>/gi;
const TITLE = /\bdescription\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
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

export function splitToolDescription(text: string): ToolDescription {
  const examples: ToolExample[] = [];
  const prose = text
    .replace(EXAMPLE, (_match, attributes: string, body: string) => {
      examples.push(example(attributes, body));
      return "\n";
    })
    .replace(WRAPPER, "")
    .replace(BLANK_RUN, "\n\n")
    .trim();
  return { prose, examples };
}
