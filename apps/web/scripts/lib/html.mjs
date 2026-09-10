// HTML templates for the blog. Every page links the same shared shell
// (assets/oxagen.css + assets/oxagen.js) the hand-authored pages do, and adds
// assets/blog.css for the parts only the blog has. No colour, no hex, no
// inline style: the palette lives in the stylesheet's token table.

export const SITE = "https://oxagen.sh";
export const BLOG_TITLE = "Oxagen Research";
export const BLOG_DESCRIPTION =
  "Research notes on ontologies, AI agents, coding agents, self-improving models, and self-evolving agents. What the papers show, where it breaks, and what it takes to govern it.";

/** @param {unknown} value */
export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** @param {string} iso YYYY-MM-DD */
export function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** @param {string} iso YYYY-MM-DD */
export function rfc822(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toUTCString();
}

export const urls = {
  blog: () => "/blog",
  post: (slug) => `/blog/${slug}`,
  pillar: (slug) => `/blog/pillars/${slug}`,
  feed: () => "/blog/feed.xml",
};

/**
 * The wordmark as inline SVG so it inherits `currentColor` like every other
 * page's brand link. The letters are recoloured to currentColor; the accent
 * `x` keeps the fill the kit cut it with.
 * @param {string} svgFile contents of assets/brand/oxagen-wordmark-on-dark.svg
 */
export function inlineWordmark(svgFile) {
  return svgFile
    .replace(/^<\?xml[^>]*>\s*/, "")
    .replace(/\s(width|height)="[^"]*"/g, "")
    .replace(/ xmlns="[^"]*"/, "")
    .replace(/aria-label="[^"]*"/, 'aria-label="oxagen"')
    .replace(
      /(<path class="letters"[^>]*?)fill="[^"]*"/,
      '$1fill="currentColor"',
    )
    .trim();
}

/** @param {{ wordmark: string, current?: "blog" }} o */
export function siteHeader({ wordmark, current }) {
  const cur = (key) => (current === key ? ' aria-current="page"' : "");
  return `<header class="nav" id="nav">
  <div class="nav-in">
    <a class="brand" href="/" aria-label="Oxagen home">${wordmark}</a>
    <nav class="nav-links" aria-label="Primary">
      <div class="drop" data-open="false">
        <button class="drop-btn" id="productsBtn" type="button" aria-expanded="false" aria-haspopup="true">Products <i class="chev"></i></button>
        <div class="drop-menu" role="menu" aria-labelledby="productsBtn">
          <a href="/products/stella" role="menuitem"><span class="dm-mark">✦</span><b>Stella</b><span>The open-source terminal agent. Rust, BYOK, every turn on the record.</span></a>
          <a href="/products/oxagen" role="menuitem"><span class="dm-mark">⬡</span><b>Oxagen</b><span>The control plane. One context map — approved, metered, logged.</span></a>
          <a href="/products/private-llms" role="menuitem"><span class="dm-mark">▣</span><b>Private LLMs</b><span>Models on hardware you control — laptop, your VPC, or air-gapped.</span></a>
          <div class="drop-sep"></div>
          <div class="drop-foot">one loop · three deployments</div>
        </div>
      </div>
      <a href="/blog"${cur("blog")}>Research</a>
      <a href="/#field-manual">Field manual</a>
      <a class="ext" href="https://docs.oxagen.sh" target="_blank" rel="noopener">Docs</a>
    </nav>
    <div class="nav-cta">
      <a class="login ext" href="https://app.oxagen.sh" target="_blank" rel="noopener">Log in</a>
      <a class="btn btn-primary btn-sm" href="/#demo">Get a demo</a>
      <button class="burger" id="burger" type="button" aria-expanded="false" aria-controls="drawer" aria-label="Menu"><i></i></button>
    </div>
  </div>
</header>

<div class="drawer" id="drawer" data-open="false">
  <div class="wrap">
    <h5>Products</h5>
    <a href="/products/stella">Stella — the terminal agent</a>
    <a href="/products/oxagen">Oxagen — the control plane</a>
    <a href="/products/private-llms">Private LLMs</a>
    <h5>More</h5>
    <a href="/blog">Research</a>
    <a href="/#field-manual">Field manual</a>
    <a href="https://docs.oxagen.sh">Docs</a>
    <a class="btn btn-primary" href="/#demo">Get a demo</a>
  </div>
</div>`;
}

/** @param {{ wordmark: string, pillars: Array<{slug: string, name: string}> }} o */
export function siteFooter({ wordmark, pillars }) {
  return `<footer>
  <div class="wrap">
    <div class="foot-grid">
      <div class="foot-brand">
        <a class="brand" href="/" aria-label="Oxagen home">${wordmark}</a>
        <p>Everyone has the same models.<br>Your edge is context.</p>
      </div>
      <nav class="foot-col" aria-label="Products">
        <h4>Products</h4>
        <ul>
          <li><a href="/products/stella">Stella — the agent</a></li>
          <li><a href="/products/oxagen">Oxagen — the platform</a></li>
          <li><a href="/products/private-llms">Private LLMs</a></li>
          <li><a href="/#demo">Get a demo</a></li>
        </ul>
      </nav>
      <nav class="foot-col" aria-label="Research">
        <h4>Research</h4>
        <ul>
          <li><a href="/blog">All posts</a></li>
${pillars.map((p) => `          <li><a href="${urls.pillar(p.slug)}">${esc(p.name)}</a></li>`).join("\n")}
          <li><a href="${urls.feed()}">RSS feed</a></li>
        </ul>
      </nav>
      <nav class="foot-col" aria-label="Resources">
        <h4>Resources</h4>
        <ul>
          <li><a class="ext" href="https://docs.oxagen.sh" target="_blank" rel="noopener">Documentation</a></li>
          <li><a class="ext" href="https://app.oxagen.sh" target="_blank" rel="noopener">Customer login</a></li>
          <li><a href="/#field-manual">Field manual</a></li>
          <li><a class="ext" href="https://github.com/oxagenai" target="_blank" rel="noopener">GitHub</a></li>
        </ul>
      </nav>
    </div>
    <div class="foot-base">
      <span>© ${new Date().getUTCFullYear()} Oxagen, Inc. All rights reserved.</span>
      <span class="mono">ship deterministic · <a href="/#field-manual">read the manual</a></span>
    </div>
  </div>
</footer>`;
}

/**
 * The document shell shared by every blog page.
 * @param {{
 *   title: string, description: string, path: string, image: string,
 *   type?: "website" | "article", ldjson?: object, body: string,
 *   wordmark: string, pillars: Array<{slug: string, name: string}>,
 *   extraHead?: string,
 * }} o
 */
export function layout(o) {
  const url = SITE + o.path;
  const image = o.image.startsWith("http") ? o.image : SITE + o.image;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(url)}">
<meta name="theme-color" content="#10100F">
<meta name="color-scheme" content="dark">
<meta property="og:type" content="${o.type ?? "website"}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:site_name" content="Oxagen">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@oxagenai">
<meta name="twitter:title" content="${esc(o.title)}">
<meta name="twitter:description" content="${esc(o.description)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="alternate" type="application/rss+xml" title="${esc(BLOG_TITLE)}" href="${urls.feed()}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="/fonts/space-grotesk-latin-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/space-grotesk-latin-600.woff2" as="font" type="font/woff2" crossorigin>
${o.ldjson ? `<script type="application/ld+json">\n${JSON.stringify(o.ldjson, null, 2).replace(/</g, "\\u003c")}\n</script>` : ""}
<script>document.documentElement.classList.add("js")</script>
<link rel="stylesheet" href="/assets/oxagen.css">
<link rel="stylesheet" href="/assets/blog.css">
${o.extraHead ?? ""}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${siteHeader({ wordmark: o.wordmark, current: "blog" })}
<main id="main">
${o.body}
</main>
${siteFooter({ wordmark: o.wordmark, pillars: o.pillars })}
<script src="/assets/oxagen.js" defer></script>
</body>
</html>
`;
}

/** @param {Array<{slug: string, name: string}>} pillars @param {string[]} slugs */
export function pillarChips(pillars, slugs) {
  const byslug = new Map(pillars.map((p) => [p.slug, p]));
  return `<ul class="chips" aria-label="Pillars">${slugs
    .map((s) => {
      const p = byslug.get(s);
      return p
        ? `<li><a class="chip" href="${urls.pillar(p.slug)}">${esc(p.name)}</a></li>`
        : "";
    })
    .join("")}</ul>`;
}

/**
 * @param {object} post
 * @param {Array<{slug: string, name: string, image: {src: string, alt: string}}>} pillars
 */
export function postCard(post, pillars) {
  const hero = heroFor(post, pillars);
  return `<article class="post-card">
  <a class="post-card-shot" href="${urls.post(post.slug)}" tabindex="-1" aria-hidden="true"><img src="${esc(hero.src)}" alt="" loading="lazy" decoding="async" width="800" height="450"></a>
  <div class="post-card-meta">
    ${pillarChips(pillars, post.pillars)}
    <h3><a href="${urls.post(post.slug)}">${esc(post.title)}</a></h3>
    <p>${esc(post.description)}</p>
    <p class="byline"><time datetime="${post.date}">${formatDate(post.date)}</time> · ${post.readingMinutes} min read</p>
  </div>
</article>`;
}

/** @param {{image: string|null, pillars: string[]}} post @param {Array<{slug: string, image: {src: string, alt: string}}>} pillars */
export function heroFor(post, pillars) {
  const primary = pillars.find((p) => p.slug === post.pillars[0]);
  if (post.image) return { src: post.image, alt: "", credit: null };
  return {
    src: primary.image.src,
    alt: primary.image.alt,
    credit: primary.image.credit,
  };
}

/** @param {{author: string, authorUrl: string, source: string, sourceUrl: string, license: string}} credit */
export function creditLine(credit) {
  return `Photo by <a href="${esc(credit.authorUrl)}" target="_blank" rel="noopener">${esc(credit.author)}</a> on <a href="${esc(credit.sourceUrl)}" target="_blank" rel="noopener">${esc(credit.source)}</a> (${esc(credit.license)})`;
}

/** @param {{ pillars: object[], posts: object[], wordmark: string }} o */
export function indexPage({ pillars, posts, wordmark }) {
  const body = `
  <section class="blog-hero tex tex-hex">
    <div class="wrap">
      <p class="eyebrow">Research</p>
      <h1>What the papers show.<br><span class="gold">What it takes to govern it.</span></h1>
      <p class="blog-hero-sub">${esc(BLOG_DESCRIPTION)}</p>
    </div>
  </section>
  <section class="sec-tight">
    <div class="wrap">
      <div class="sec-head"><p class="eyebrow">Pillars</p><h2>Five threads, one map</h2><p>Every post links to at least one pillar. Follow a pillar for the full line of argument.</p></div>
      <div class="pillar-grid">
${pillars
  .map(
    (p) => `        <a class="pillar-card" href="${urls.pillar(p.slug)}">
          <img src="${esc(p.image.src)}" alt="" loading="lazy" decoding="async" width="640" height="360">
          <div class="pillar-card-body"><h3>${esc(p.name)}</h3><p>${esc(p.tagline)}</p><span class="pillar-count">${posts.filter((x) => x.pillars.includes(p.slug)).length} posts</span></div>
        </a>`,
  )
  .join("\n")}
      </div>
    </div>
  </section>
  <section class="sec-tight sec-alt">
    <div class="wrap">
      <div class="sec-head"><p class="eyebrow">Latest</p><h2>All posts</h2></div>
      <div class="post-grid">
${posts.map((p) => postCard(p, pillars)).join("\n")}
      </div>
    </div>
  </section>`;
  return layout({
    title: `${BLOG_TITLE} — the science of ontologies, agents, and self-improving systems`,
    description: BLOG_DESCRIPTION,
    path: urls.blog(),
    image: "/og.png",
    body,
    wordmark,
    pillars,
    ldjson: {
      "@context": "https://schema.org",
      "@type": "Blog",
      name: BLOG_TITLE,
      url: SITE + urls.blog(),
      description: BLOG_DESCRIPTION,
      publisher: { "@type": "Organization", name: "Oxagen, Inc.", url: SITE },
    },
  });
}

/** @param {{ pillar: object, pillars: object[], posts: object[], wordmark: string }} o */
export function pillarPage({ pillar, pillars, posts, wordmark }) {
  const body = `
  <section class="pillar-hero">
    <div class="pillar-hero-shot"><img src="${esc(pillar.image.src)}" alt="${esc(pillar.image.alt)}" width="1600" height="900" decoding="async" fetchpriority="high"></div>
    <div class="wrap pillar-hero-copy">
      <p class="eyebrow"><a href="${urls.blog()}">Research</a> · Pillar</p>
      <h1>${esc(pillar.name)}</h1>
      <p class="pillar-tagline">${esc(pillar.tagline)}</p>
      <p class="pillar-desc">${esc(pillar.description)}</p>
      <p class="credit">${creditLine(pillar.image.credit)}</p>
    </div>
  </section>
  <section class="sec-tight sec-alt">
    <div class="wrap">
      <div class="sec-head"><h2>${posts.length === 1 ? "1 post" : `${posts.length} posts`} in ${esc(pillar.name)}</h2></div>
      ${posts.length ? `<div class="post-grid">\n${posts.map((p) => postCard(p, pillars)).join("\n")}\n      </div>` : `<p class="empty">Nothing here yet. <a href="${urls.blog()}">See all posts.</a></p>`}
      <nav class="pillar-nav" aria-label="Other pillars">
        <span class="mono">Other pillars</span>
        ${pillars
          .filter((p) => p.slug !== pillar.slug)
          .map(
            (p) =>
              `<a class="chip" href="${urls.pillar(p.slug)}">${esc(p.name)}</a>`,
          )
          .join("\n        ")}
      </nav>
    </div>
  </section>`;
  return layout({
    title: `${pillar.name} — ${BLOG_TITLE}`,
    description: pillar.description,
    path: urls.pillar(pillar.slug),
    image: pillar.image.src,
    body,
    wordmark,
    pillars,
    ldjson: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: pillar.name,
      url: SITE + urls.pillar(pillar.slug),
      description: pillar.description,
      isPartOf: { "@type": "Blog", name: BLOG_TITLE, url: SITE + urls.blog() },
    },
  });
}

/**
 * @param {{ post: object, html: string, headings: Array<{depth: number, id: string, text: string}>,
 *   pillars: object[], related: object[], wordmark: string }} o
 */
export function postPage({ post, html, headings, pillars, related, wordmark }) {
  const hero = heroFor(post, pillars);
  // remark-rehype hardcodes the footnote section's heading id; keep it out of the TOC
  const toc = headings.filter(
    (h) => h.depth === 2 && h.id !== "footnote-label",
  );
  const primary = pillars.find((p) => p.slug === post.pillars[0]);
  const body = `
  <article class="post">
    <header class="post-head">
      <div class="wrap post-head-in">
        <p class="eyebrow"><a href="${urls.blog()}">Research</a> · <a href="${urls.pillar(primary.slug)}">${esc(primary.name)}</a></p>
        <h1>${esc(post.title)}</h1>
        <p class="post-sub">${esc(post.description)}</p>
        <p class="byline">
          <span>${post.authors.map(esc).join(", ")}</span> ·
          <time datetime="${post.date}">${formatDate(post.date)}</time>${post.updated ? ` · updated <time datetime="${post.updated}">${formatDate(post.updated)}</time>` : ""} ·
          <span>${post.readingMinutes} min read</span>
        </p>
        ${pillarChips(pillars, post.pillars)}
      </div>
      <figure class="post-hero">
        <img src="${esc(hero.src)}" alt="${esc(hero.alt)}" width="1600" height="900" decoding="async" fetchpriority="high">
        ${hero.credit ? `<figcaption class="credit">${creditLine(hero.credit)}</figcaption>` : ""}
      </figure>
    </header>
    <div class="wrap post-body">
      ${toc.length > 1 ? `<nav class="toc" aria-label="In this post"><p class="mono">In this post</p><ol>${toc.map((h) => `<li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`).join("")}</ol></nav>` : ""}
      <div class="prose">
${html}
      </div>
    </div>
    <footer class="post-foot">
      <div class="wrap">
        ${post.tags.length ? `<p class="tags mono">${post.tags.map((t) => `<span>#${esc(t)}</span>`).join(" ")}</p>` : ""}
        ${related.length ? `<div class="sec-head"><p class="eyebrow">Keep reading</p><h2>Related posts</h2></div><div class="post-grid">${related.map((r) => postCard(r, pillars)).join("\n")}</div>` : ""}
      </div>
    </footer>
  </article>`;
  return layout({
    title: `${post.title} — ${BLOG_TITLE}`,
    description: post.description,
    path: urls.post(post.slug),
    image: hero.src,
    type: "article",
    body,
    wordmark,
    pillars,
    extraHead: `<meta property="article:published_time" content="${post.date}">${post.updated ? `\n<meta property="article:modified_time" content="${post.updated}">` : ""}${post.pillars.map((p) => `\n<meta property="article:section" content="${esc(pillars.find((x) => x.slug === p)?.name ?? p)}">`).join("")}${post.tags.map((t) => `\n<meta property="article:tag" content="${esc(t)}">`).join("")}`,
    ldjson: {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: post.title,
      description: post.description,
      datePublished: post.date,
      dateModified: post.updated ?? post.date,
      author: post.authors.map((name) => ({ "@type": "Organization", name })),
      publisher: {
        "@type": "Organization",
        name: "Oxagen, Inc.",
        url: SITE,
        logo: `${SITE}/assets/brand/oxagen-wordmark.svg`,
      },
      image: SITE + hero.src,
      url: SITE + urls.post(post.slug),
      mainEntityOfPage: SITE + urls.post(post.slug),
      keywords: [
        ...post.pillars.map(
          (p) => pillars.find((x) => x.slug === p)?.name ?? p,
        ),
        ...post.tags,
      ].join(", "),
      wordCount: post.wordCount,
      isPartOf: { "@type": "Blog", name: BLOG_TITLE, url: SITE + urls.blog() },
    },
  });
}

/** @param {object[]} posts newest first @param {object[]} pillars */
export function feedXml(posts, pillars) {
  const items = posts
    .map(
      (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${SITE}${urls.post(p.slug)}</link>
      <guid isPermaLink="true">${SITE}${urls.post(p.slug)}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <description>${esc(p.description)}</description>
${p.pillars.map((s) => `      <category>${esc(pillars.find((x) => x.slug === s)?.name ?? s)}</category>`).join("\n")}
    </item>`,
    )
    .join("\n");
  const last = posts[0]
    ? rfc822(posts[0].date)
    : rfc822(new Date().toISOString().slice(0, 10));
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(BLOG_TITLE)}</title>
    <link>${SITE}${urls.blog()}</link>
    <atom:link href="${SITE}${urls.feed()}" rel="self" type="application/rss+xml"/>
    <description>${esc(BLOG_DESCRIPTION)}</description>
    <language>en-us</language>
    <lastBuildDate>${last}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

/**
 * Merge the hand-maintained sitemap (static pages) with the blog's URLs.
 * @param {string} existingXml the committed sitemap.xml
 * @param {Array<{loc: string, lastmod?: string, changefreq?: string}>} entries
 */
export function mergeSitemap(existingXml, entries) {
  const close = existingXml.lastIndexOf("</urlset>");
  if (close < 0) throw new Error("sitemap.xml has no </urlset>");
  const existing = new Set(
    [...existingXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]),
  );
  const added = entries
    .filter((e) => !existing.has(e.loc))
    .map(
      (e) =>
        `  <url><loc>${esc(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}<changefreq>${e.changefreq ?? "monthly"}</changefreq></url>`,
    )
    .join("\n");
  return `${existingXml.slice(0, close).trimEnd()}\n${added}\n</urlset>\n`;
}
