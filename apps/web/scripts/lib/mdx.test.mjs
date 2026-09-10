import { describe, expect, it } from "vitest";
import { buildComponents, renderMdx, slugifyHeading, textOf } from "./mdx.mjs";

describe("slugifyHeading", () => {
  it("lowercases, strips punctuation, and hyphenates", () => {
    expect(slugifyHeading("What an Ontology Buys an Agent?")).toBe(
      "what-an-ontology-buys-an-agent",
    );
    expect(slugifyHeading("  Façade: résumé & CV  ")).toBe("facade-resume-cv");
    expect(slugifyHeading("a --- b")).toBe("a-b");
  });
});

describe("textOf", () => {
  it("flattens nested React children to text", () => {
    expect(
      textOf([
        "a",
        1,
        null,
        false,
        { props: { children: ["b", { props: { children: "c" } }] } },
      ]),
    ).toBe("a1bc");
    expect(textOf(undefined)).toBe("");
  });
});

describe("renderMdx", () => {
  it("renders headings with ids and anchors, and records them for the TOC", async () => {
    const { html, headings } = await renderMdx(
      "## First\n\ntext\n\n### Sub\n\n## First\n\n#### Deep\n",
    );
    expect(headings).toEqual([
      { depth: 2, id: "first", text: "First" },
      { depth: 3, id: "sub", text: "Sub" },
      { depth: 2, id: "first-2", text: "First" },
    ]);
    expect(html).toContain(
      '<h2 id="first"><a href="#first" class="anchor" aria-label="Link to First">#</a>First</h2>',
    );
    expect(html).toContain('<h4 id="deep">');
  });

  it("renders GFM footnotes as a References section", async () => {
    const { html, headings } = await renderMdx(
      "A claim.[^1]\n\n[^1]: Author (2020). *Title*. https://arxiv.org/abs/0000.00000\n",
    );
    expect(html).toContain("data-footnote-ref");
    expect(html).toContain('class="footnotes"');
    expect(html).toContain(">References<");
    expect(headings.some((h) => h.id === "footnote-label")).toBe(true);
    expect(html).toContain(
      'href="https://arxiv.org/abs/0000.00000" target="_blank" rel="noopener"',
    );
  });

  it("opens external links in a new tab and leaves internal ones alone", async () => {
    const { html } = await renderMdx(
      "[ext](https://example.com) [int](/blog) [hash](#top)",
    );
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener">ext</a>',
    );
    expect(html).toContain('<a href="/blog">int</a>');
    expect(html).toContain('<a href="#top">hash</a>');
  });

  it("wraps tables for horizontal scroll", async () => {
    const { html } = await renderMdx("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(html).toContain('<div class="table-wrap"><table>');
  });

  it("supports the Callout and Figure components", async () => {
    const { html } = await renderMdx(
      '<Callout kind="warn" title="Careful">Body text</Callout>\n\n<Callout>Plain</Callout>\n\n<Figure src="/x.png" alt="An x" caption="Cap" />\n\n<Figure src="/y.png" />',
    );
    expect(html).toContain(
      '<aside class="callout callout-warn" role="note"><p class="callout-title">Careful</p><div class="callout-body">Body text</div></aside>',
    );
    expect(html).toContain(
      '<aside class="callout callout-note" role="note"><div class="callout-body">Plain</div></aside>',
    );
    expect(html).toContain(
      '<figure class="figure"><img src="/x.png" alt="An x" loading="lazy" decoding="async"/><figcaption>Cap</figcaption></figure>',
    );
    expect(html).toContain(
      '<figure class="figure"><img src="/y.png" alt="" loading="lazy" decoding="async"/></figure>',
    );
  });

  it("falls back to a positional id for headings with no slug text", async () => {
    const state = { headings: [] };
    const { h2 } = buildComponents(state);
    const el = h2({ children: "!!!" });
    expect(el.props.id).toBe("section-1");
  });

  it("surfaces MDX syntax errors", async () => {
    await expect(renderMdx("<Unclosed>")).rejects.toThrow();
  });
});
