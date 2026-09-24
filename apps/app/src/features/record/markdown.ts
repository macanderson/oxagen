// The statement's grammar (mockup `hlMd`): a record's statement is markdown
// prose, so the editor paints it line by line the way the mockup's shared
// editor paints a SKILL.md. Headings, block quotes, list markers, inline code
// and bold each take their own token; everything else is text.
//
// Pure and line-oriented, because the editor draws one block per logical line
// so a wrapped line keeps its number, its paint and its find marks in the same
// box.

export type MarkdownTokenKind =
  | "heading"
  | "quote"
  | "marker"
  | "code"
  | "strong"
  | "fence"
  | "text";

export type MarkdownToken = { kind: MarkdownTokenKind; text: string };

/** Inline code and bold inside one line of prose; the rest is text. */
function inline(line: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];
  const pattern = /`[^`\n]+`|\*\*[^*\n]+\*\*/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const at = match.index;
    if (at > last) tokens.push({ kind: "text", text: line.slice(last, at) });
    tokens.push({
      kind: match[0].startsWith("`") ? "code" : "strong",
      text: match[0],
    });
    last = at + match[0].length;
  }
  if (last < line.length) tokens.push({ kind: "text", text: line.slice(last) });
  return tokens;
}

/**
 * The statement as tokens, one array per logical line. Joining every line's
 * token texts with "\n" gives back the source exactly.
 */
export function tokenizeMarkdown(source: string): MarkdownToken[][] {
  let fenced = false;
  return source.split("\n").map((line) => {
    if (line.startsWith("```")) {
      fenced = !fenced;
      return [{ kind: "fence", text: line }];
    }
    if (fenced) return [{ kind: "code", text: line }];
    if (/^#{1,6}\s/.test(line)) return [{ kind: "heading", text: line }];
    if (/^\s*>/.test(line)) return [{ kind: "quote", text: line }];
    const item = /^(\s*(?:\d+\.|[-*+]))(\s[\s\S]*)$/.exec(line);
    if (item?.[1] !== undefined && item[2] !== undefined)
      return [{ kind: "marker", text: item[1] }, ...inline(item[2])];
    return inline(line);
  });
}
