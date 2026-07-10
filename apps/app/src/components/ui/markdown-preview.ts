/**
 * markdown-preview — turn markdown source into a clean single-run plain-text
 * preview for clamped/truncated list surfaces.
 *
 * Product rule: we never show raw markdown *language* to the user, even in a
 * truncated preview. Line-clamping rendered markdown HTML (block elements) is
 * unreliable across browsers, so for the clamped preview we strip the markdown
 * syntax down to readable prose and clamp THAT. The full, formatted content is
 * shown (as styled HTML) in the reveal popover via <MarkdownContent>.
 *
 * This is intentionally lightweight and dependency-free — it is a display
 * heuristic, not a spec-complete markdown parser.
 */

/** Collapse markdown source to a clean, single-spaced plain-text string. */
export function markdownToPlainText(md: string): string {
  if (!md) return "";
  let out = md;

  // Fenced code blocks → keep inner text, drop the fences and language hint.
  out = out.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) => code);
  // Inline code → keep the code text, drop the backticks.
  out = out.replace(/`([^`]+)`/g, "$1");
  // Images ![alt](url) → alt text.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links [text](url) → text.
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Headings, blockquotes, list markers at line start.
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  out = out.replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, "");
  // Emphasis / bold / strikethrough markers.
  out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
  out = out.replace(/(\*|_)(.*?)\1/g, "$2");
  out = out.replace(/~~(.*?)~~/g, "$1");
  // Horizontal rules.
  out = out.replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, "");
  // Table pipes / separator rows → spaces.
  out = out.replace(/^\s*\|?[\s:-]+\|[\s:|-]*$/gm, "");
  out = out.replace(/\s*\|\s*/g, " ");
  // Collapse whitespace runs (including newlines) to single spaces.
  out = out.replace(/\s+/g, " ");

  return out.trim();
}
