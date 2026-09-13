import { describe, expect, it } from "vitest";
import {
  BLOG_TITLE,
  esc,
  feedXml,
  formatDate,
  picture,
  indexPage,
  inlineWordmark,
  layout,
  mergeSitemap,
  pillarChips,
  pillarPage,
  postCard,
  postPage,
  rfc822,
  siteFooter,
  siteHeader,
  urls,
} from "./html.mjs";

const imagesFor = (base) => ({
  og: { dark: `${base}/og-dark.png`, light: `${base}/og-light.png` },
  banner: {
    dark: `${base}/banner-dark.png`,
    light: `${base}/banner-light.png`,
  },
  thumb: { dark: `${base}/thumb-dark.png`, light: `${base}/thumb-light.png` },
});
const pillars = [
  {
    slug: "alpha",
    name: "Alpha",
    tagline: "First.",
    description: "The first pillar.",
    order: 1,
    treatment: "ontology",
    images: imagesFor("/blog/pillars/alpha"),
  },
  {
    slug: "beta",
    name: "Beta & co",
    tagline: "Second.",
    description: "The second pillar.",
    order: 2,
    treatment: null,
    images: imagesFor("/blog/pillars/beta"),
  },
];
const post = {
  slug: "my-post",
  title: 'Title <"quoted">',
  description: "Desc & more",
  date: "2026-09-09",
  updated: null,
  pillars: ["alpha", "beta"],
  authors: ["Oxagen Research"],
  tags: ["graphs"],
  image: null,
  draft: false,
  wordCount: 1200,
  readingMinutes: 5,
  images: imagesFor("/blog/my-post"),
};
const wordmark = "<svg>W</svg>";

describe("helpers", () => {
  it("escapes HTML", () => {
    expect(esc('<a href="x">&\'</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
    expect(esc(null)).toBe("");
  });

  it("formats dates in UTC", () => {
    expect(formatDate("2026-09-09")).toBe("September 9, 2026");
    expect(rfc822("2026-01-01")).toBe("Thu, 01 Jan 2026 00:00:00 GMT");
  });

  it("builds urls", () => {
    expect(urls.post("x")).toBe("/blog/x");
    expect(urls.pillar("y")).toBe("/blog/pillars/y");
    expect(urls.feed()).toBe("/blog/feed.xml");
  });

  it("inlines the wordmark with currentColor letters", () => {
    const svg =
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="2" viewBox="0 0 10 2" role="img" aria-label="oxagen logo"><path class="letters" d="M0" fill="#ABCDEF"/><path class="accent" d="M1" fill="#D6962C"/></svg>';
    const out = inlineWordmark(svg);
    expect(out).toBe(
      '<svg viewBox="0 0 10 2" role="img" aria-label="oxagen"><path class="letters" d="M0" fill="currentColor"/><path class="accent" d="M1" fill="#D6962C"/></svg>',
    );
  });

  it("offers the light rendering to a light-scheme viewer, dark by default", () => {
    expect(
      picture(
        { dark: "/d.png", light: "/l.png" },
        { alt: 'A "shot"', width: 800, height: 450, lazy: true },
      ),
    ).toBe(
      '<picture><source srcset="/l.png" media="(prefers-color-scheme: light)"><img src="/d.png" alt="A &quot;shot&quot;" width="800" height="450" loading="lazy" decoding="async"></picture>',
    );
    expect(
      picture(
        { dark: "/same.jpg", light: "/same.jpg" },
        { alt: "", width: 1600, height: 900, priority: true },
      ),
    ).toBe(
      '<img src="/same.jpg" alt="" width="1600" height="900" decoding="async" fetchpriority="high">',
    );
  });

  it("renders chips with escaping", () => {
    expect(pillarChips(pillars, ["beta", "missing"])).toBe(
      '<ul class="chips" aria-label="Pillars"><li><a class="chip" href="/blog/pillars/beta">Beta &amp; co</a></li></ul>',
    );
  });
});

describe("chrome", () => {
  it("marks the blog link current and lists pillars in the footer", () => {
    const header = siteHeader({ wordmark, current: "blog" });
    expect(header).toContain(
      '<a href="/blog" aria-current="page">Research</a>',
    );
    expect(siteHeader({ wordmark })).toContain('<a href="/blog">Research</a>');
    const footer = siteFooter({ wordmark, pillars });
    expect(footer).toContain(
      '<li><a href="/blog/pillars/alpha">Alpha</a></li>',
    );
    expect(footer).toContain("Beta &amp; co");
    expect(footer).toContain(`© ${new Date().getUTCFullYear()} Oxagen`);
  });

  it("layout emits canonical, OG, feed link, and JSON-LD with escaped </script>", () => {
    const html = layout({
      title: "T",
      description: "D",
      path: "/blog/x",
      image: "/i.png",
      body: "<p>hi</p>",
      wordmark,
      pillars,
      ldjson: { a: "</script>" },
    });
    expect(html).toContain(
      '<link rel="canonical" href="https://oxagen.sh/blog/x">',
    );
    expect(html).toContain(
      '<meta property="og:image" content="https://oxagen.sh/i.png">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta property="og:image:alt" content="T">',
    );
    expect(html).toContain('<link rel="alternate" type="application/rss+xml"');
    expect(html).toContain('"a": "\\u003c/script>"');
    expect(html).toContain('<link rel="stylesheet" href="/assets/blog.css">');
    expect(html).toContain("<p>hi</p>");
    const abs = layout({
      title: "T",
      description: "D",
      path: "/",
      image: "https://cdn/x.png",
      imageAlt: "Alt",
      body: "",
      wordmark,
      pillars,
    });
    expect(abs).toContain('content="https://cdn/x.png"');
    expect(abs).toContain('<meta property="og:image:alt" content="Alt">');
    expect(abs).not.toContain("application/ld+json");
  });
});

describe("pages", () => {
  it("postCard escapes and links", () => {
    const card = postCard(post, pillars);
    expect(card).toContain(
      '<h3><a href="/blog/my-post">Title &lt;&quot;quoted&quot;&gt;</a></h3>',
    );
    expect(card).toContain(
      '<time datetime="2026-09-09">September 9, 2026</time> · 5 min read',
    );
    expect(card).toContain(
      '<picture><source srcset="/blog/my-post/thumb-light.png" media="(prefers-color-scheme: light)"><img src="/blog/my-post/thumb-dark.png" alt="" width="800" height="450" loading="lazy"',
    );
  });

  it("indexPage lists pillars with counts and every post", () => {
    const html = indexPage({
      pillars,
      posts: [post],
      wordmark,
      image: "/blog/og-dark.png",
    });
    expect(html).toContain(
      '<meta property="og:image" content="https://oxagen.sh/blog/og-dark.png">',
    );
    expect(html).toContain(
      '<source srcset="/blog/pillars/alpha/thumb-light.png" media="(prefers-color-scheme: light)"><img src="/blog/pillars/alpha/thumb-dark.png" alt="" width="640" height="360"',
    );
    expect(html).toContain(
      `<title>${BLOG_TITLE} — the science of ontologies, agents, and self-improving systems</title>`,
    );
    expect(html).toContain(
      '<a class="pillar-card" href="/blog/pillars/alpha">',
    );
    expect(html).toContain('<span class="pillar-count">1 posts</span>');
    expect(html).toContain('"@type": "Blog"');
    expect(html.match(/class="post-card"/g)).toHaveLength(1);
  });

  it("pillarPage handles posts, the empty state, and other-pillar nav", () => {
    const withPosts = pillarPage({
      pillar: pillars[0],
      pillars,
      posts: [post],
      wordmark,
    });
    expect(withPosts).toContain("<h2>1 post in Alpha</h2>");
    expect(withPosts).toContain(
      '<a class="chip" href="/blog/pillars/beta">Beta &amp; co</a>',
    );
    expect(withPosts).not.toContain(
      'href="/blog/pillars/alpha">Alpha</a>\n      </nav>',
    );
    expect(withPosts).toContain(
      '<div class="pillar-hero-shot"><picture><source srcset="/blog/pillars/alpha/banner-light.png" media="(prefers-color-scheme: light)"><img src="/blog/pillars/alpha/banner-dark.png" alt="" width="1600" height="900" decoding="async" fetchpriority="high"></picture></div>',
    );
    expect(withPosts).toContain(
      '<meta property="og:image" content="https://oxagen.sh/blog/pillars/alpha/og-dark.png">',
    );
    expect(withPosts).not.toContain("credit");
    const empty = pillarPage({
      pillar: pillars[1],
      pillars,
      posts: [],
      wordmark,
    });
    expect(empty).toContain("<h2>0 posts in Beta &amp; co</h2>");
    expect(empty).toContain('class="empty"');
  });

  it("postPage renders header, TOC, prose, tags, related, and article metadata", () => {
    const headings = [
      { depth: 2, id: "one", text: "One" },
      { depth: 3, id: "sub", text: "Sub" },
      { depth: 2, id: "two", text: "Two" },
      { depth: 2, id: "footnote-label", text: "References" },
    ];
    const related = [{ ...post, slug: "other", title: "Other" }];
    const html = postPage({
      post: { ...post, updated: "2026-09-10" },
      html: "<p>body</p>",
      headings,
      pillars,
      related,
      wordmark,
    });
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain(
      '<meta property="article:published_time" content="2026-09-09">',
    );
    expect(html).toContain(
      '<meta property="article:modified_time" content="2026-09-10">',
    );
    expect(html).toContain('<meta property="article:section" content="Alpha">');
    expect(html).toContain('<meta property="article:tag" content="graphs">');
    expect(html).toContain(
      '<nav class="toc" aria-label="In this post"><p class="mono">In this post</p><ol><li><a href="#one">One</a></li><li><a href="#two">Two</a></li></ol></nav>',
    );
    expect(html).toContain("<p>body</p>");
    expect(html).toContain(
      'updated <time datetime="2026-09-10">September 10, 2026</time>',
    );
    expect(html).toContain("<span>#graphs</span>");
    expect(html).toContain('<a href="/blog/other">Other</a>');
    expect(html).toContain('"@type": "BlogPosting"');
    expect(html).toContain('"wordCount": 1200');
    expect(html).toContain(
      '<figure class="post-hero">\n        <picture><source srcset="/blog/my-post/banner-light.png" media="(prefers-color-scheme: light)"><img src="/blog/my-post/banner-dark.png" alt="" width="1600" height="900" decoding="async" fetchpriority="high"></picture>',
    );
    expect(html).toContain(
      '<meta property="og:image" content="https://oxagen.sh/blog/my-post/og-dark.png">',
    );
    expect(html).toContain(
      '<meta property="og:image:alt" content="Title &lt;&quot;quoted&quot;&gt;">',
    );
    expect(html).toContain(
      '"image": "https://oxagen.sh/blog/my-post/og-dark.png"',
    );
  });

  it("postPage omits the TOC with fewer than two sections and shows a post's own image plainly", () => {
    const html = postPage({
      post: {
        ...post,
        image: "/own.jpg",
        tags: [],
        images: {
          ...post.images,
          banner: { dark: "/own.jpg", light: "/own.jpg" },
        },
      },
      html: "",
      headings: [{ depth: 2, id: "one", text: "One" }],
      pillars,
      related: [],
      wordmark,
    });
    expect(html).not.toContain('class="toc"');
    expect(html).toContain(
      '<figure class="post-hero">\n        <img src="/own.jpg" alt="" width="1600" height="900" decoding="async" fetchpriority="high">',
    );
    expect(html).not.toContain("<picture>");
    expect(html).not.toContain('class="tags');
    expect(html).not.toContain("Keep reading");
  });
});

describe("feeds", () => {
  it("feedXml lists items with categories", () => {
    const xml = feedXml([post], pillars);
    expect(xml).toContain("<title>Title &lt;&quot;quoted&quot;&gt;</title>");
    expect(xml).toContain(
      '<guid isPermaLink="true">https://oxagen.sh/blog/my-post</guid>',
    );
    expect(xml).toContain("<category>Alpha</category>");
    expect(xml).toContain("<category>Beta &amp; co</category>");
    expect(xml).toContain(
      "<lastBuildDate>Wed, 09 Sep 2026 00:00:00 GMT</lastBuildDate>",
    );
    expect(feedXml([], pillars)).toContain("<lastBuildDate>");
  });

  it("mergeSitemap appends only new locations", () => {
    const existing =
      '<?xml version="1.0"?>\n<urlset>\n  <url><loc>https://oxagen.sh/</loc></url>\n</urlset>\n';
    const out = mergeSitemap(existing, [
      { loc: "https://oxagen.sh/", changefreq: "weekly" },
      { loc: "https://oxagen.sh/blog", changefreq: "weekly" },
      { loc: "https://oxagen.sh/blog/x", lastmod: "2026-09-09" },
    ]);
    expect(out).toBe(
      '<?xml version="1.0"?>\n<urlset>\n  <url><loc>https://oxagen.sh/</loc></url>\n  <url><loc>https://oxagen.sh/blog</loc><changefreq>weekly</changefreq></url>\n  <url><loc>https://oxagen.sh/blog/x</loc><lastmod>2026-09-09</lastmod><changefreq>monthly</changefreq></url>\n</urlset>\n',
    );
    expect(() => mergeSitemap("<nope/>", [])).toThrow(/urlset/);
  });
});
