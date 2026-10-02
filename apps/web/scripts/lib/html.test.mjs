import { describe, expect, it } from "vitest";
import {
  BLOG_TITLE,
  esc,
  feedXml,
  formatDate,
  HERO_FONT_PRELOAD,
  picture,
  indexPage,
  inlineWordmark,
  latestPosts,
  layout,
  lockup,
  mergeSitemap,
  pillarChips,
  pillarPage,
  postCard,
  postPage,
  rfc822,
  siteFooter,
  siteHeader,
  THEME_HEAD,
  THEME_SWITCH,
  urls,
  withSiteHeader,
} from "./html.mjs";

const imagesFor = (base) => ({
  og: `${base}/og.png`,
  banner: `${base}/banner.png`,
  thumb: `${base}/thumb.png`,
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
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="2" viewBox="0 0 10 2" role="img" aria-label="oxagen logo"><path class="letters" d="M0" fill="#ABCDEF"/><path class="accent" d="M1" fill="#D4AF37"/></svg>';
    const out = inlineWordmark(svg);
    expect(out).toBe(
      '<svg viewBox="0 0 10 2" role="img" aria-label="oxagen"><path class="letters" d="M0" fill="currentColor"/><path class="accent" d="M1" fill="#D4AF37"/></svg>',
    );
  });

  it("is one <img> on ink, with no light-scheme alternative to offer", () => {
    expect(
      picture("/d.png", {
        alt: 'A "shot"',
        width: 800,
        height: 450,
        lazy: true,
      }),
    ).toBe(
      '<img src="/d.png" alt="A &quot;shot&quot;" width="800" height="450" loading="lazy" decoding="async">',
    );
    expect(
      picture("/own.jpg", {
        alt: "",
        width: 1600,
        height: 900,
        priority: true,
      }),
    ).toBe(
      '<img src="/own.jpg" alt="" width="1600" height="900" decoding="async" fetchpriority="high">',
    );
    expect(picture("/d.png", { alt: "", width: 1, height: 1 })).not.toContain(
      "<picture",
    );
  });

  it("renders chips with escaping", () => {
    expect(pillarChips(pillars, ["beta", "missing"])).toBe(
      '<ul class="chips" aria-label="Pillars"><li><a class="chip" href="/blog/pillars/beta">Beta &amp; co</a></li></ul>',
    );
  });
});

describe("chrome", () => {
  it("marks Research current on the blog and lists pillars in the footer", () => {
    const header = siteHeader({ wordmark, current: "blog" });
    expect(header).toContain('<a href="/blog" aria-current="page">All research');
    expect(header).toMatch(
      /<div class="nav-item nav-item--mega" data-open="false" data-current>\s*<button class="nav-trigger"[^>]*aria-controls="menu-research">Research/,
    );
    const plain = siteHeader({ wordmark });
    expect(plain).toContain('<a href="/blog">All research');
    expect(plain).not.toContain("data-current");
    const footer = siteFooter({ wordmark, pillars });
    expect(footer).toContain(
      '<li><a href="/blog/pillars/alpha">Alpha</a></li>',
    );
    expect(footer).toContain("Beta &amp; co");
    expect(footer).toContain(`© ${new Date().getUTCFullYear()} Oxagen`);
  });

  it("links the terms of service and the privacy policy from the footer", () => {
    const footer = siteFooter({ wordmark, pillars });
    expect(footer).toContain('<nav class="foot-col" aria-label="Legal">');
    expect(footer).toContain('<a href="/terms">Terms of service</a>');
    expect(footer).toContain('<a href="/privacy">Privacy policy</a>');
  });

  it("puts the four menus in the island, in order, each behind a button", () => {
    const header = siteHeader({ wordmark });
    const labels = [
      ...header.matchAll(/<button class="nav-trigger"[^>]*>([^<]+)</g),
    ].map((m) => m[1]);
    expect(labels).toEqual(["Product", "Research", "Resources", "Company"]);
    for (const id of ["product", "research", "resources", "company"]) {
      expect(header).toContain(`aria-controls="menu-${id}"`);
      expect(header).toContain(`<div class="menu menu--`);
      expect(header).toContain(`id="menu-${id}"`);
    }
    // Every menu starts closed, and its button says so.
    expect(header.match(/aria-expanded="true"/g)).toBeNull();
    expect(header).toContain('<a class="brand" href="/" aria-label="Oxagen home"><svg viewBox="0 0 604.125 115.625"');
  });

  it("lists the docs, the app login, and the open source projects under Resources", () => {
    const header = siteHeader({ wordmark });
    const menu = header.slice(
      header.indexOf('id="menu-resources"'),
      header.indexOf('id="menu-company"'),
    );
    for (const href of [
      "https://docs.oxagen.sh",
      "https://app.oxagen.sh",
      "https://stella.oxagen.sh/docs",
      "https://contextgraphprotocol.org",
      "https://github.com/macanderson/context-graph-protocol",
    ]) {
      expect(menu).toContain(`href="${href}"`);
    }
    // Stella and the protocol sit under one Open source heading, each with
    // its own links indented beneath it.
    const oss = menu.slice(menu.indexOf("Open source"));
    expect(oss.match(/<div class="oss">/g)).toHaveLength(2);
    expect(oss.match(/<ul class="oss-sub">/g)).toHaveLength(2);
    // A link that leaves the site opens in a new tab.
    expect(menu).toContain(
      '<a class="mm-a" href="https://docs.oxagen.sh" target="_blank" rel="noopener">',
    );
  });

  it("fills Research with the pillars and the newest posts it is given", () => {
    const header = siteHeader({
      wordmark,
      pillars,
      latest: [{ slug: "my-post", title: "Post <one>", pillar: "Alpha" }],
    });
    expect(header).toContain(
      '<a class="mm-topic" href="/blog/pillars/beta"><b>Beta &amp; co</b><span>Second.</span></a>',
    );
    expect(header).toContain(
      '<a class="mm-post" href="/blog/my-post">Post &lt;one&gt;<small>Alpha</small></a>',
    );
    const bare = siteHeader({ wordmark, pillars: [{ slug: "x", name: "X" }], latest: [{ slug: "p", title: "P" }] });
    expect(bare).toContain('<a class="mm-topic" href="/blog/pillars/x"><b>X</b></a>');
    expect(bare).toContain('<a class="mm-post" href="/blog/p">P</a>');
  });

  it("gives the header one Get a demo button, gold unless the page asks for ghost", () => {
    const gold = siteHeader({ wordmark });
    expect(gold.match(/class="btn [^"]*"[^>]*>Get a demo/g)).toEqual([
      'class="btn btn-primary btn-sm" href="/#demo">Get a demo',
    ]);
    const ghost = siteHeader({ wordmark, demo: "ghost" });
    expect(ghost).toContain('class="btn btn-ghost btn-sm" href="/#demo">Get a demo');
    expect(ghost).not.toContain("btn-primary");
  });

  it("gives the phone menu one section per menu and no demo button", () => {
    const header = siteHeader({ wordmark, pillars });
    const drawer = header.slice(header.indexOf('<div class="drawer"'));
    const sections = [
      ...drawer.matchAll(/<summary>([^<]+)</g),
    ].map((m) => m[1]);
    expect(sections).toEqual(["Product", "Research", "Resources", "Company"]);
    expect(drawer).toContain('<a href="/products/oxagen">Overview</a>');
    expect(drawer).toContain('<a href="/blog/pillars/alpha">Alpha</a>');
    expect(drawer).toContain("Stella docs");
    expect(drawer).toContain("Context Graph Protocol");
    // One Get a demo, in the header (#4901).
    expect(drawer).not.toContain("btn");
    expect(drawer).not.toContain("Get a demo");
  });

  it("draws the lockup: the hive beside the wordmark's own paths", () => {
    const svg = lockup('<svg viewBox="0 0 10 10" role="img"><path d="M0"/></svg>\n');
    expect(svg).toMatch(/^<svg viewBox="0 0 604\.125 115\.625" role="img" aria-label="oxagen">/);
    expect(svg).toContain('<g transform="translate(150.257,11.190)"><path d="M0"/></g></svg>');
    expect(svg.match(/fill="#D4AF37"/g)).toHaveLength(2);
  });

  it("fills a page's header placeholder and leaves other pages alone", () => {
    const render = ({ demo }) => `[header ${demo}]`;
    expect(withSiteHeader("a<!-- site-header -->b", render)).toBe("a[header primary]b");
    expect(withSiteHeader('<!--site-header demo="ghost"-->', render)).toBe("[header ghost]");
    expect(withSiteHeader('<!-- site-header demo="primary" -->', render)).toBe("[header primary]");
    expect(withSiteHeader("<p>no header</p>", render)).toBe("<p>no header</p>");
  });

  it("names the newest posts with their first pillar", () => {
    const posts = [
      { slug: "a", title: "A", pillars: ["beta", "alpha"] },
      { slug: "b", title: "B", pillars: ["gone"] },
      { slug: "c", title: "C", pillars: ["alpha"] },
    ];
    expect(latestPosts(posts, pillars, 2)).toEqual([
      { slug: "a", title: "A", pillar: "Beta & co" },
      { slug: "b", title: "B", pillar: undefined },
    ]);
    expect(latestPosts(posts, pillars)).toHaveLength(3);
  });

  it("puts the System / Light / Dark control in the footer, System first", () => {
    const footer = siteFooter({ wordmark, pillars });
    expect(footer).toContain(THEME_SWITCH);
    const order = [...THEME_SWITCH.matchAll(/data-theme-choice="(\w+)"/g)].map(
      (m) => m[1],
    );
    expect(order).toEqual(["system", "light", "dark"]);
    // One tab stop: only the checked choice is reachable before script runs.
    expect(THEME_SWITCH.match(/tabindex="-1"/g)).toHaveLength(2);
  });

  it("stamps the stored theme before the stylesheet loads", () => {
    const html = layout({
      title: "T",
      description: "D",
      path: "/blog/",
      image: "/x.png",
      body: "",
      wordmark,
      pillars,
    });
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html.indexOf(THEME_HEAD)).toBeGreaterThan(-1);
    expect(html.indexOf(THEME_HEAD)).toBeLessThan(
      html.indexOf('<link rel="stylesheet" href="/assets/oxagen.css">'),
    );
  });

  // Runs the head script against a stub document: `stored` is what
  // localStorage holds (or a throw), `osLight` the OS preference.
  function runHead({ stored, osLight }) {
    const root = {
      attrs: {},
      classList: { add() {} },
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
    };
    const scheme = { content: "light dark" };
    // One theme-color tag per OS preference, as the head declares them. Their
    // starting values are what an untouched pair looks like.
    const colors = [
      { media: "(prefers-color-scheme: light)", content: "#FFFFFF" },
      { media: "(prefers-color-scheme: dark)", content: "#09090B" },
    ];
    const document = {
      documentElement: root,
      querySelector: () => scheme,
      querySelectorAll: () => colors,
    };
    const localStorage = {
      getItem() {
        if (stored instanceof Error) throw stored;
        return stored;
      },
    };
    const matchMedia = () => ({ matches: osLight });
    const body = THEME_HEAD.replace(/^<script>|<\/script>$/g, "");
    new Function("document", "localStorage", "matchMedia", body)(
      document,
      localStorage,
      matchMedia,
    );
    return { theme: root.attrs["data-theme"], scheme, colors };
  }

  it("head script paints the browser chrome in a pinned theme, not the OS's", () => {
    const pinned = runHead({ stored: "dark", osLight: true });
    expect(pinned.theme).toBe("dark");
    expect(pinned.scheme.content).toBe("dark");
    expect(pinned.colors.map((m) => m.content)).toEqual(["#09090B", "#09090B"]);
    // Nothing pinned: the pair is left exactly as declared, so the browser keeps
    // choosing between them and a later OS change still moves the chrome. Writing
    // the resolved colour into both would read the same at load and then stick.
    const system = runHead({ stored: null, osLight: true });
    expect(system.theme).toBe("light");
    expect(system.colors.map((m) => m.content)).toEqual(["#FFFFFF", "#09090B"]);
    const blocked = runHead({ stored: new Error("blocked"), osLight: false });
    expect(blocked.theme).toBe("dark");
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
    // Installable like the hand-authored pages: the launch screens and the
    // install prompt ride in after the manifest.
    expect(html).toContain(
      '<link rel="manifest" href="/oxagen.webmanifest">\n<!-- pwa: written by tools/scripts/sync-brand-assets.mjs -->',
    );
    expect(html).toContain('rel="apple-touch-startup-image"');
    expect(html).toContain(
      '<script src="/assets/install-prompt.js" defer data-icon="/icon-192.png"></script>',
    );
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
      '<img src="/blog/my-post/thumb.png" alt="" width="960" height="480" loading="lazy"',
    );
  });

  it("indexPage lists pillars with counts and every post", () => {
    const html = indexPage({
      pillars,
      posts: [post],
      wordmark,
      image: "/blog/og.png",
    });
    expect(html).toContain(
      '<meta property="og:image" content="https://oxagen.sh/blog/og.png">',
    );
    expect(html).toContain(
      '<img src="/blog/pillars/alpha/thumb.png" alt="" width="960" height="480"',
    );
    expect(html).toContain(
      `<title>${BLOG_TITLE}: the science of ontologies, agents, and self-improving systems</title>`,
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
      '<section class="pillar-hero hero-field">\n    <div class="hero-art" aria-hidden="true"><img src="/blog/pillars/alpha/banner.png" alt="" width="2400" height="1200" decoding="async" fetchpriority="high"></div>',
    );
    expect(withPosts).toContain(
      '<meta property="og:image" content="https://oxagen.sh/blog/pillars/alpha/og.png">',
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
      '<header class="post-head hero-field">\n      <div class="hero-art" aria-hidden="true"><img src="/blog/my-post/banner.png" alt="" width="2400" height="1200" decoding="async" fetchpriority="high"></div>',
    );
    expect(html).toContain('<div class="wrap"><div class="post-head-in">');
    expect(html).not.toContain("post-hero");
    expect(html).toContain(
      '<meta property="og:image" content="https://oxagen.sh/blog/my-post/og.png">',
    );
    expect(html).toContain(
      '<meta property="og:image:alt" content="Title &lt;&quot;quoted&quot;&gt;">',
    );
    expect(html).toContain('"image": "https://oxagen.sh/blog/my-post/og.png"');
  });

  it("postPage omits the TOC with fewer than two sections and shows a post's own image plainly", () => {
    const html = postPage({
      post: {
        ...post,
        image: "/own.jpg",
        tags: [],
        images: { ...post.images, banner: "/own.jpg" },
      },
      html: "",
      headings: [{ depth: 2, id: "one", text: "One" }],
      pillars,
      related: [],
      wordmark,
    });
    expect(html).not.toContain('class="toc"');
    expect(html).toContain(
      '<div class="hero-art" aria-hidden="true"><img src="/own.jpg" alt="" width="2400" height="1200" decoding="async" fetchpriority="high"></div>',
    );
    expect(html).not.toContain("<picture>");
    expect(html).not.toContain('class="tags');
    expect(html).not.toContain("Keep reading");
  });
});

describe("hero font", () => {
  // Mac, 2026-09-29: Space Grotesk sets the wordmark and hero line 1, and
  // nothing else. The wordmark is an SVG, so on a blog page the face reaches
  // only an element marked .hero-line-1, and only a page with a hero
  // downloads it.
  const postHtml = () =>
    postPage({
      post,
      html: "<p>body</p>",
      headings: [],
      pillars,
      related: [],
      wordmark,
    });

  it("marks line 1 of the index hero and leaves line 2 in the heading face", () => {
    const html = indexPage({
      pillars,
      posts: [post],
      wordmark,
      image: "/blog/og.png",
    });
    expect(html).toContain(
      '<h1><span class="hero-line-1">What the research says about agents,</span><br><span class="gold">and how to govern them</span></h1>',
    );
    expect(html.match(/hero-line-1/g)).toHaveLength(1);
    expect(html).toContain(HERO_FONT_PRELOAD);
  });

  it("marks the one-line pillar hero", () => {
    const html = pillarPage({
      pillar: pillars[0],
      pillars,
      posts: [post],
      wordmark,
    });
    expect(html).toContain('<h1 class="hero-line-1">Alpha</h1>');
    expect(html).toContain(HERO_FONT_PRELOAD);
  });

  it("sets a post title in the heading face and preloads no Space Grotesk", () => {
    const html = postHtml();
    expect(html).toContain("<h1>Title &lt;&quot;quoted&quot;&gt;</h1>");
    expect(html).not.toContain("hero-line-1");
    expect(html).not.toContain("space-grotesk");
  });

  it("preloads one Space Grotesk weight for a hero and none without one", () => {
    expect(HERO_FONT_PRELOAD.match(/space-grotesk-latin-\d+/g)).toEqual([
      "space-grotesk-latin-600",
    ]);
    const html = layout({
      title: "T",
      description: "D",
      path: "/blog/",
      image: "/x.png",
      body: "",
      wordmark,
      pillars,
    });
    expect(html).not.toContain("space-grotesk");
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
