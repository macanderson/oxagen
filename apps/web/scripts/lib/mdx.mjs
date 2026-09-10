// MDX → static HTML. Each post compiles to a React component, renders once
// with renderToStaticMarkup, and is never shipped as JavaScript: the browser
// gets plain HTML. React is a build-time dependency only.

import { compile, run } from "@mdx-js/mdx";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import remarkGfm from "remark-gfm";

/**
 * A URL-safe id from heading text, mirroring what GitHub does: lowercase,
 * drop punctuation, hyphenate whitespace.
 * @param {string} text
 */
export function slugifyHeading(text) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** @param {unknown} node */
export function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node)
    return textOf(node.props?.children);
  return "";
}

/**
 * The component map every post renders with. Headings get ids (and are
 * recorded for the table of contents), external links open in a new tab,
 * tables get a scroll wrapper, and the two authoring components live here.
 * @param {{ headings: Array<{depth: number, id: string, text: string}> }} state
 */
export function buildComponents(state) {
  const used = new Map();
  const heading = (depth) => (props) => {
    const text = textOf(props.children);
    // an id set upstream (remark-rehype's footnote label) wins over the slug
    let id =
      props.id ??
      (slugifyHeading(text) || `section-${state.headings.length + 1}`);
    const n = used.get(id) ?? 0;
    used.set(id, n + 1);
    if (n > 0) id = `${id}-${n + 1}`;
    if (depth <= 3) state.headings.push({ depth, id, text });
    return createElement(
      `h${depth}`,
      { ...props, id },
      createElement(
        "a",
        {
          href: `#${id}`,
          className: "anchor",
          "aria-label": `Link to ${text}`,
        },
        "#",
      ),
      props.children,
    );
  };
  return {
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    a: ({ href, children, ...rest }) => {
      const external = typeof href === "string" && /^https?:\/\//.test(href);
      return createElement(
        "a",
        external
          ? { href, target: "_blank", rel: "noopener", ...rest }
          : { href, ...rest },
        children,
      );
    },
    table: (props) =>
      createElement(
        "div",
        { className: "table-wrap" },
        createElement("table", props),
      ),
    Callout: ({ kind = "note", title, children }) =>
      createElement(
        "aside",
        {
          className: `callout callout-${kind === "warn" ? "warn" : "note"}`,
          role: "note",
        },
        title
          ? createElement("p", { className: "callout-title" }, title)
          : null,
        createElement("div", { className: "callout-body" }, children),
      ),
    Figure: ({ src, alt = "", caption }) =>
      createElement(
        "figure",
        { className: "figure" },
        createElement("img", { src, alt, loading: "lazy", decoding: "async" }),
        caption ? createElement("figcaption", null, caption) : null,
      ),
  };
}

/**
 * Compile one MDX body and render it to HTML.
 * @param {string} body MDX source with the frontmatter already removed
 * @param {{ file?: string }} [opts]
 * @returns {Promise<{ html: string, headings: Array<{depth: number, id: string, text: string}> }>}
 */
export async function renderMdx(body, opts = {}) {
  const compiled = await compile(body, {
    outputFormat: "function-body",
    development: false,
    remarkPlugins: [remarkGfm],
    remarkRehypeOptions: {
      footnoteLabel: "References",
      footnoteLabelTagName: "h2",
      footnoteLabelProperties: { className: ["refs-title"], id: "references" },
      footnoteBackLabel: (referenceIndex, rereferenceIndex) =>
        `Back to reference ${referenceIndex + 1}${rereferenceIndex > 1 ? `-${rereferenceIndex}` : ""}`,
    },
  });
  const { default: Content } = await run(String(compiled), {
    ...jsxRuntime,
    Fragment,
    baseUrl: opts.file ? `file://${opts.file}` : undefined,
  });
  const state = { headings: [] };
  const html = renderToStaticMarkup(
    createElement(Content, { components: buildComponents(state) }),
  );
  return { html, headings: state.headings };
}
