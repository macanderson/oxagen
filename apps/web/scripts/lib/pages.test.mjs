import { describe, expect, it } from "vitest";
import {
  cardTitle,
  decodeEntities,
  pageKey,
  pageKind,
  pageMeta,
  withOgImage,
} from "./pages.mjs";

const page = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Stella &amp; friends | Oxagen</title>
<meta name="description" content="Agents you can &quot;check&quot;.">
<meta property="og:title" content="Stella">
<meta property="og:image" content="https://oxagen.sh/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://oxagen.sh/og.png">
</head><body></body></html>`;

describe("pageMeta", () => {
  it("reads the title and description, decoding entities", () => {
    expect(pageMeta(page)).toEqual({
      title: "Stella & friends | Oxagen",
      description: 'Agents you can "check".',
    });
    expect(pageMeta("<html></html>")).toEqual({ title: "", description: "" });
    expect(decodeEntities("&lt;a&gt; &#39;x&#x27; &apos;")).toBe("<a> 'x' '");
  });
});

describe("cardTitle", () => {
  it("drops the site name off the end, in any of its separators", () => {
    expect(cardTitle("Stella | Oxagen")).toBe("Stella");
    expect(cardTitle("Stella — Oxagen")).toBe("Stella");
    expect(cardTitle("Stella · Oxagen ")).toBe("Stella");
    expect(cardTitle("Oxagen — The control plane")).toBe(
      "Oxagen — The control plane",
    );
    expect(cardTitle(" Oxagen ")).toBe("Oxagen");
  });
});

describe("pageKey and pageKind", () => {
  it("names a card after its page's path", () => {
    expect(pageKey("index.html")).toBe("index");
    expect(pageKey("products/stella/index.html")).toBe("products-stella");
    expect(pageKey("overview-video.html")).toBe("overview-video");
    expect(pageKey("a\\b\\index.html")).toBe("a-b");
  });

  it("uses the page's section as the eyebrow", () => {
    expect(pageKind("index.html")).toBe("Oxagen");
    expect(pageKind("products/stella/index.html")).toBe("Products");
    expect(pageKind("overview-video.html")).toBe("Overview Video");
  });
});

describe("withOgImage", () => {
  const card = {
    url: "https://oxagen.sh/og/products-stella-dark.png",
    width: 1200,
    height: 630,
    alt: 'Stella & "friends"',
  };

  it("replaces the declared image tags with the card and its size and alt", () => {
    const out = withOgImage(page, card);
    expect(out).not.toContain("og.png");
    expect(out.match(/property="og:image"/g)).toHaveLength(1);
    expect(out.match(/name="twitter:image"/g)).toHaveLength(1);
    expect(out).toContain(
      '</title>\n<meta property="og:image" content="https://oxagen.sh/og/products-stella-dark.png">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta property="og:image:alt" content="Stella &amp; &quot;friends&quot;">\n<meta name="twitter:image" content="https://oxagen.sh/og/products-stella-dark.png">',
    );
    expect(out).toContain('<meta property="og:title" content="Stella">');
  });

  it("adds the tags to a page that declared none, and is idempotent", () => {
    const bare = "<html><head><title>T</title></head><body></body></html>";
    const once = withOgImage(bare, card);
    expect(once).toContain('<meta property="og:image:alt"');
    expect(withOgImage(once, card)).toBe(once);
  });

  it("refuses a page with no title", () => {
    expect(() => withOgImage("<html><head></head></html>", card)).toThrow(
      /no <title>/,
    );
  });
});
