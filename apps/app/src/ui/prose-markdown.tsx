"use client";
// Markdown a third party wrote, rendered as HTML a person can read: a tool's
// description as the provider that published it wrote it. Headings, lists,
// emphasis, and fenced code render. Raw HTML in the source renders as the
// text it was written as, never as markup.
//
// Two reasons for the last rule. The text is untrusted, and a description is
// written for a model, which reads angle brackets as placeholders: Notion's
// `ADD COLUMN "Name" <type>` and `<data-source>` are words in a sentence.
// Streamdown's default sanitizer would delete them as unknown elements and
// leave the sentence missing its nouns.
import { createCodePlugin } from "@streamdown/code";
import { defaultRemarkPlugins, Streamdown } from "streamdown";

/** Shiki for fenced code, both themes as CSS variables (see `assistant-markdown.tsx`). */
const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

/**
 * An image renders as its alt text and is never fetched. A description is
 * third-party text, and an image URL in it would have the viewer's browser
 * report the page view to whoever wrote it.
 */
function InertImage({ alt }: { alt?: string }) {
  return alt ? <span>{alt}</span> : null;
}

/** The part of an mdast node this file reads. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** Parents whose children are blocks, so loose text needs a paragraph round it. */
const BLOCK_PARENTS = new Set([
  "root",
  "blockquote",
  "listItem",
  "footnoteDefinition",
]);

function literal(node: MdNode): void {
  if (node.children === undefined) return;
  const block = BLOCK_PARENTS.has(node.type);
  node.children = node.children.map((child) => {
    if (child.type !== "html") {
      literal(child);
      return child;
    }
    const text: MdNode = { type: "text", value: child.value ?? "" };
    return block ? { type: "paragraph", children: [text] } : text;
  });
}

/** A remark plugin: every raw HTML node becomes a text node with the same source. */
export function htmlAsText() {
  return (tree: MdNode) => {
    literal(tree);
  };
}

/** Streamdown's own remark plugins (GFM and code meta) with `htmlAsText` last. */
const REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), htmlAsText];

/**
 * `text-sm` prose sized for a dialog. Streamdown sizes headings for a page
 * (`h1` is `text-3xl`), so every heading steps down to the body's scale and
 * keeps its weight. Wide tables and code scroll inside themselves.
 */
const PROSE_CLASS =
  "max-w-none text-sm text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:text-base [&_h2]:text-base [&_h3]:text-sm [&_h4]:text-sm [&_h5]:text-sm [&_h6]:text-sm [&_li]:py-0.5 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto";

const COMPONENTS = { img: InertImage };

export function ProseMarkdown({ children }: { children: string }) {
  return (
    <Streamdown
      mode="static"
      shikiTheme={["github-light", "github-dark"]}
      remarkPlugins={REMARK_PLUGINS}
      components={COMPONENTS}
      plugins={{ code: codePlugin }}
      controls={{ code: { copy: true, download: false } }}
      className={PROSE_CLASS}
    >
      {children}
    </Streamdown>
  );
}
