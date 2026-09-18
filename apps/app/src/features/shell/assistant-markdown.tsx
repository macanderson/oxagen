"use client";
// Renders an assistant reply as markdown instead of a plain string, so
// headings, lists and prose get real line-height and sizing and a fenced code
// block gets a monospace, per-language syntax highlighter instead of a plain
// `<pre>`. Streamdown is the one place that config lives; `assistant-streaming-
// text.tsx` is the only other caller, passing `streaming: true` while it is
// still revealing characters so an unterminated fence or bold marker never
// renders as broken HTML mid-reveal (`parseIncompleteMarkdown`).
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";

/**
 * Shiki highlighting for fenced code. `[light, dark]` emits both themes as
 * inline `--shiki-light`/`--shiki-dark` CSS variables and Streamdown's
 * `dark:` Tailwind utilities pick between them off the `.dark` class on
 * `<html>` — no JS theme detection, no flash.
 */
const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

export interface AssistantMarkdownProps {
  children: string;
  /** True while the text is still being revealed (see `assistant-streaming-text.tsx`). */
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
      plugins={{ code: codePlugin }}
      controls={{ code: { copy: true, download: false } }}
      className="max-w-none text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto"
    >
      {children}
    </Streamdown>
  );
}
