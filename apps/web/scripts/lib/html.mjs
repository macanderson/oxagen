// HTML templates for the blog. Every page links the same shared shell
// (assets/oxagen.css + assets/oxagen.js) the hand-authored pages do, and adds
// assets/blog.css for the parts only the blog has. No colour, no hex, no
// inline style: the palette lives in the stylesheet's token table.

export const SITE = "https://oxagen.sh";
export const BLOG_TITLE = "Oxagen Research";
export const BLOG_DESCRIPTION =
  "Research notes on ontologies, AI agents, coding agents, self-improving models, self-evolving agents, and autonomous agents. Each note covers what the papers show, where the methods fail, and what it takes to govern the agents built on them.";

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
      <a href="/products/oxagen">Product</a>
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
    <h5>Product</h5>
    <a href="/products/oxagen">Oxagen, the agent control plane</a>
    <h5>More</h5>
    <a href="/blog">Research</a>
    <a href="/#field-manual">Field manual</a>
    <a href="https://docs.oxagen.sh">Docs</a>
    <a class="btn btn-primary" href="/#demo">Get a demo</a>
  </div>
</div>`;
}

// The footer's theme control and the head script that applies the stored
// choice before first paint. index.html and products/oxagen/index.html carry
// copies of both; change all three together. oxagen.js wires the buttons.
export const THEME_SWITCH = `<div class="theme-switch" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" aria-checked="true" data-theme-choice="system" aria-label="System" title="System"><svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg></button>
          <button type="button" role="radio" aria-checked="false" tabindex="-1" data-theme-choice="light" aria-label="Light" title="Light"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg></button>
          <button type="button" role="radio" aria-checked="false" tabindex="-1" data-theme-choice="dark" aria-label="Dark" title="Dark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg></button>
        </div>`;

export const THEME_HEAD = `<script>
/* Stamp the theme before first paint: a pinned choice from the footer's
   control, else the OS. oxagen.js keeps it current after load. */
(function (d) {
  d.classList.add("js");
  var c = null;
  try { c = localStorage.getItem("theme"); } catch (e) {}
  var t = c === "light" || c === "dark" ? c
    : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  d.setAttribute("data-theme", t);
  var m = document.querySelector('meta[name="color-scheme"]');
  if (m) m.content = t;
  if (c === t) {
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (x) {
      x.content = t === "light" ? "#FFFFFF" : "#09090B";
    });
  }
})(document.documentElement);
</script>`;

/** @param {{ wordmark: string, pillars: Array<{slug: string, name: string}> }} o */
export function siteFooter({ wordmark, pillars }) {
  return `<footer>
  <div class="wrap">
    <div class="foot-grid">
      <div class="foot-brand">
        <a class="brand" href="/" aria-label="Oxagen home">${wordmark}</a>
        <p>See which agent spent what,<br>and on whose behalf.</p>
      </div>
      <nav class="foot-col" aria-label="Product">
        <h4>Product</h4>
        <ul>
          <li><a href="/products/oxagen">Oxagen, the agent control plane</a></li>
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
      <div class="foot-col">
        <h4>Contact</h4>
        <address>
          Oxagen, Inc.<br>
          2261 Market Street STE 87168<br>
          San Francisco, CA 94114<br>
          <a href="mailto:hello@oxagen.sh">hello@oxagen.sh</a><br>
          <a href="mailto:success@oxagen.sh">success@oxagen.sh</a><br>
          <a href="tel:+13102137912">+1 (310) 213-7912</a>
        </address>
      </div>
    </div>
    <div class="foot-base">
      <span>© ${new Date().getUTCFullYear()} Oxagen, Inc. All rights reserved.</span>
      <div class="foot-end">
        <span class="mono">agent control plane · <a href="/#field-manual">read the manual</a></span>
        ${THEME_SWITCH}
      </div>
    </div>
  </div>
</footer>`;
}

/**
 * The document shell shared by every blog page.
 * @param {{
 *   title: string, description: string, path: string, image: string,
 *   imageAlt?: string,
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
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#FFFFFF">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#09090B">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="${o.type ?? "website"}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:site_name" content="Oxagen">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(o.imageAlt ?? o.title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@oxagenai">
<meta name="twitter:title" content="${esc(o.title)}">
<meta name="twitter:description" content="${esc(o.description)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="alternate" type="application/rss+xml" title="${esc(BLOG_TITLE)}" href="${urls.feed()}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/oxagen.webmanifest">
<link rel="preload" href="/fonts/space-grotesk-latin-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/space-grotesk-latin-600.woff2" as="font" type="font/woff2" crossorigin>
${o.ldjson ? `<script type="application/ld+json">\n${JSON.stringify(o.ldjson, null, 2).replace(/</g, "\\u003c")}\n</script>` : ""}
${THEME_HEAD}
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
 * A generated image. There is one rendering, on ink: the site is ink, and an
 * ink image reads on a paper ground where a paper image on paper would not,
 * so nothing is offered to a viewer who prefers light.
 * @param {string} src
 * @param {{ alt: string, width: number, height: number, lazy?: boolean, priority?: boolean }} o
 */
export function picture(src, o) {
  const loading = o.lazy ? ' loading="lazy"' : "";
  const priority = o.priority ? ' fetchpriority="high"' : "";
  return `<img src="${esc(src)}" alt="${esc(o.alt)}" width="${o.width}" height="${o.height}"${loading} decoding="async"${priority}>`;
}

/**
 * A page's banner laid behind its title: the picture fills the section and
 * the stylesheet masks it out toward the words, so the prose sits on ink
 * and the drawing comes through beside it. Decorative, so hidden from
 * readers who hear the page.
 * @param {string} src
 */
export function heroArt(src) {
  return `<div class="hero-art" aria-hidden="true">${picture(src, { alt: "", width: 2400, height: 1200, priority: true })}</div>`;
}

/**
 * @param {object} post with `images` from the build
 * @param {Array<{slug: string, name: string}>} pillars
 */
export function postCard(post, pillars) {
  return `<article class="post-card">
  <a class="post-card-shot" href="${urls.post(post.slug)}" tabindex="-1" aria-hidden="true">${picture(post.images.thumb, { alt: "", width: 960, height: 480, lazy: true })}</a>
  <div class="post-card-meta">
    ${pillarChips(pillars, post.pillars)}
    <h3><a href="${urls.post(post.slug)}">${esc(post.title)}</a></h3>
    <p>${esc(post.description)}</p>
    <p class="byline"><time datetime="${post.date}">${formatDate(post.date)}</time> · ${post.readingMinutes} min read</p>
  </div>
</article>`;
}

/** @param {{ pillars: object[], posts: object[], wordmark: string, image: string }} o */
export function indexPage({ pillars, posts, wordmark, image }) {
  const body = `
  <section class="blog-hero tex tex-hex">
    <div class="wrap">
      <p class="eyebrow">Research</p>
      <h1>What the research says about agents,<br><span class="gold">and how to govern them</span></h1>
      <p class="blog-hero-sub">${esc(BLOG_DESCRIPTION)}</p>
    </div>
  </section>
  <section class="sec-tight">
    <div class="wrap">
      <div class="sec-head"><p class="eyebrow">Pillars</p><h2>Research topics</h2><p>Every post belongs to at least one pillar. Open a pillar to see all of its posts.</p></div>
      <div class="pillar-grid">
${pillars
  .map(
    (p) => `        <a class="pillar-card" href="${urls.pillar(p.slug)}">
          ${picture(p.images.thumb, { alt: "", width: 960, height: 480, lazy: true })}
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
    title: `${BLOG_TITLE}: the science of ontologies, agents, and self-improving systems`,
    description: BLOG_DESCRIPTION,
    path: urls.blog(),
    image,
    imageAlt: BLOG_TITLE,
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
  <section class="pillar-hero hero-field">
    ${heroArt(pillar.images.banner)}
    <div class="wrap"><div class="pillar-hero-copy">
      <p class="eyebrow"><a href="${urls.blog()}">Research</a> · Pillar</p>
      <h1>${esc(pillar.name)}</h1>
      <p class="pillar-tagline">${esc(pillar.tagline)}</p>
      <p class="pillar-desc">${esc(pillar.description)}</p>
    </div></div>
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
    title: `${pillar.name} · ${BLOG_TITLE}`,
    description: pillar.description,
    path: urls.pillar(pillar.slug),
    image: pillar.images.og,
    imageAlt: pillar.name,
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
  // remark-rehype hardcodes the footnote section's heading id; keep it out of the TOC
  const toc = headings.filter(
    (h) => h.depth === 2 && h.id !== "footnote-label",
  );
  const primary = pillars.find((p) => p.slug === post.pillars[0]);
  const body = `
  <article class="post">
    <header class="post-head hero-field">
      ${heroArt(post.images.banner)}
      <div class="wrap"><div class="post-head-in">
        <p class="eyebrow"><a href="${urls.blog()}">Research</a> · <a href="${urls.pillar(primary.slug)}">${esc(primary.name)}</a></p>
        <h1>${esc(post.title)}</h1>
        <p class="post-sub">${esc(post.description)}</p>
        <p class="byline">
          <span>${post.authors.map(esc).join(", ")}</span> ·
          <time datetime="${post.date}">${formatDate(post.date)}</time>${post.updated ? ` · updated <time datetime="${post.updated}">${formatDate(post.updated)}</time>` : ""} ·
          <span>${post.readingMinutes} min read</span>
        </p>
        ${pillarChips(pillars, post.pillars)}
      </div></div>
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
    title: `${post.title} · ${BLOG_TITLE}`,
    description: post.description,
    path: urls.post(post.slug),
    image: post.images.og,
    imageAlt: post.title,
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
      image: SITE + post.images.og,
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
