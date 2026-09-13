#!/usr/bin/env node
// Assemble the publishable site into dist/:
//   1. copy the hand-authored site (everything that is not source or config)
//   2. build the blog from content/ (pillars.yaml + posts/*/index.mdx)
//   3. write blog/feed.xml and a sitemap.xml that includes the blog
//
// The output is what CI syncs to the bucket. Nothing in dist/ is committed.

import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContentError,
  countWords,
  groupByPillar,
  loadPillars,
  parseFrontmatter,
  readingMinutes,
  relatedPosts,
  sortPosts,
  validatePost,
} from "./lib/content.mjs";
import { TREATMENTS } from "./lib/art.mjs";
import {
  BLOG_DESCRIPTION,
  feedXml,
  formatDate,
  indexPage,
  inlineWordmark,
  mergeSitemap,
  pillarPage,
  postPage,
  SITE,
  urls,
} from "./lib/html.mjs";
import { BANNER, bannerSvg, OG, ogSvg, THUMB } from "./lib/images.mjs";
import { renderMdx } from "./lib/mdx.mjs";
import {
  cardTitle,
  pageKey,
  pageKind,
  pageMeta,
  withOgImage,
} from "./lib/pages.mjs";
import { renderPng } from "./lib/raster.mjs";
import { THEMES } from "./lib/theme.mjs";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const DIST = path.join(ROOT, "dist");
export const CONTENT = path.join(ROOT, "content");

/**
 * Top-level entries of apps/web that are source, config, or tooling rather
 * than site content. Everything else is copied verbatim.
 */
export const NOT_SITE = new Set([
  "content",
  "coverage",
  "dist",
  "node_modules",
  "package.json",
  "README.md",
  "scripts",
  "vercel.json",
  "vitest.config.mjs",
]);

/** @param {string} name */
export function isPublishable(name) {
  return !NOT_SITE.has(name) && !name.startsWith(".");
}

/**
 * Read every post folder. A folder is a post when it holds an index.mdx;
 * anything else next to it (an image, a data file) is copied alongside so a
 * post can carry its own assets at /blog/<slug>/<file>.
 * @param {{ pillars: object[], includeDrafts?: boolean }} o
 */
export async function loadPosts({ pillars, includeDrafts = false }) {
  const dir = path.join(CONTENT, "posts");
  const entries = await readdir(dir, { withFileTypes: true });
  const posts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const file = path.join(dir, slug, "index.mdx");
    let source;
    try {
      source = await readFile(file, "utf8");
    } catch {
      throw new ContentError(
        `post folder "${slug}" has no index.mdx`,
        path.relative(ROOT, file),
      );
    }
    const rel = path.relative(ROOT, file);
    const { data, body } = parseFrontmatter(source, rel);
    const meta = validatePost(data, { slug, pillars, file: rel });
    if (meta.draft && !includeDrafts) continue;
    const wordCount = countWords(body);
    posts.push({
      ...meta,
      file,
      body,
      wordCount,
      readingMinutes: readingMinutes(wordCount),
    });
  }
  return sortPosts(posts);
}

/** @param {string} file @param {string | Buffer} content */
async function emit(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/**
 * Render a share card in both themes, and unless `ogOnly`, a banner and a
 * thumbnail too, into dist/<base>/. Returns the site-absolute URLs. A post
 * that ships its own `image` keeps it for the banner and thumbnail; the card
 * is still generated, since it carries the title.
 * @param {{ base: string, seed: string, treatment?: string, override?: string | null,
 *   ogOnly?: boolean, og: { title: string, summary: string, kind: string, meta: string[] } }} o
 */
async function generateImages(o) {
  const dir = path.join(DIST, o.base);
  const url = (name) => `${o.base}/${name}`;
  const images = { og: {}, banner: {}, thumb: {} };
  for (const theme of THEMES) {
    const card = ogSvg({
      seed: o.seed,
      theme,
      treatment: o.treatment,
      ...o.og,
    });
    await emit(
      path.join(dir, `og-${theme}.png`),
      renderPng(card, { width: OG.w }),
    );
    images.og[theme] = url(`og-${theme}.png`);
    if (o.ogOnly) continue;
    if (o.override) {
      images.banner[theme] = o.override;
      images.thumb[theme] = o.override;
      continue;
    }
    const banner = bannerSvg({ seed: o.seed, theme, treatment: o.treatment });
    await emit(
      path.join(dir, `banner-${theme}.png`),
      renderPng(banner, { width: BANNER.w }),
    );
    await emit(
      path.join(dir, `thumb-${theme}.png`),
      renderPng(banner, { width: THUMB.w }),
    );
    images.banner[theme] = url(`banner-${theme}.png`);
    images.thumb[theme] = url(`thumb-${theme}.png`);
  }
  return images;
}

/** Every .html under `dir` (relative paths), skipping the blog the build wrote itself. */
async function htmlPages(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(path.join(dir, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (rel === "blog" || rel === "og") continue;
    if (entry.isDirectory()) out.push(...(await htmlPages(dir, rel)));
    else if (entry.name.endsWith(".html")) out.push(rel);
  }
  return out.sort();
}

export async function build({ log = console.log } = {}) {
  const started = Date.now();
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // 1. the hand-authored site
  let copied = 0;
  for (const name of await readdir(ROOT)) {
    if (!isPublishable(name)) continue;
    await cp(path.join(ROOT, name), path.join(DIST, name), {
      recursive: true,
      // nested dotfiles (.DS_Store and friends) are not site content either
      filter: (src) => !path.basename(src).startsWith("."),
    });
    copied += 1;
  }

  // 2. the blog
  const pillars = loadPillars(
    await readFile(path.join(CONTENT, "pillars.yaml"), "utf8"),
  );
  const posts = await loadPosts({
    pillars,
    includeDrafts: process.env.BLOG_DRAFTS === "1",
  });

  // the images: a banner, a thumbnail and a share card per pillar and per
  // post, and a share card for the index, all generated, all under /blog
  let images = 0;
  for (const [i, pillar] of pillars.entries()) {
    const count = posts.filter((p) => p.pillars.includes(pillar.slug)).length;
    pillar.images = await generateImages({
      base: urls.pillar(pillar.slug),
      seed: `pillar:${pillar.slug}`,
      treatment: pillar.treatment ?? TREATMENTS[i % TREATMENTS.length],
      og: {
        title: pillar.name,
        summary: pillar.tagline,
        kind: "Research · Pillar",
        meta: [`${count} ${count === 1 ? "post" : "posts"}`],
      },
    });
    images += 6;
  }
  for (const post of posts) {
    if (post.image) {
      const onDisk = path.join(ROOT, post.image.replace(/^\//, ""));
      const sidecar = path.join(
        path.dirname(post.file),
        path.basename(post.image),
      );
      const found = await Promise.all(
        [onDisk, sidecar].map((f) => stat(f).catch(() => null)),
      );
      if (!found.some((info) => info?.isFile()))
        throw new ContentError(
          `post "${post.slug}" image ${post.image} is missing`,
          path.relative(ROOT, post.file),
        );
    }
    const primary = pillars.find((p) => p.slug === post.pillars[0]);
    post.images = await generateImages({
      base: urls.post(post.slug),
      seed: post.slug,
      override: post.image,
      og: {
        title: post.title,
        summary: post.description,
        kind: `Research · ${primary.name}`,
        meta: [formatDate(post.date), `${post.readingMinutes} min read`],
      },
    });
    images += post.image ? 2 : 6;
  }
  const blogCard = await generateImages({
    base: urls.blog(),
    seed: "blog",
    treatment: "graph",
    ogOnly: true,
    og: {
      title: "What the papers show. What it takes to govern it.",
      summary: BLOG_DESCRIPTION,
      kind: "Research",
      meta: [`${posts.length} posts`],
    },
  });
  images += 2;

  const wordmark = inlineWordmark(
    await readFile(
      path.join(ROOT, "assets/brand/oxagen-wordmark-on-dark.svg"),
      "utf8",
    ),
  );

  for (const post of posts) {
    const { html, headings } = await renderMdx(post.body, { file: post.file });
    if (!/id="user-content-fn-|class="footnotes"/.test(html)) {
      throw new ContentError(
        "post has no footnote references; every post cites its sources",
        path.relative(ROOT, post.file),
      );
    }
    const page = postPage({
      post,
      html,
      headings,
      pillars,
      related: relatedPosts(post, posts),
      wordmark,
    });
    await emit(path.join(DIST, "blog", post.slug, "index.html"), page);
    // sidecar assets next to the post
    const folder = path.dirname(post.file);
    for (const sibling of await readdir(folder)) {
      if (sibling === "index.mdx" || sibling.startsWith(".")) continue;
      await cp(
        path.join(folder, sibling),
        path.join(DIST, "blog", post.slug, sibling),
        { recursive: true },
      );
    }
  }

  const byPillar = groupByPillar(pillars, posts);
  for (const pillar of pillars) {
    await emit(
      path.join(DIST, "blog", "pillars", pillar.slug, "index.html"),
      pillarPage({
        pillar,
        pillars,
        posts: byPillar.get(pillar.slug),
        wordmark,
      }),
    );
  }
  await emit(
    path.join(DIST, "blog", "index.html"),
    indexPage({ pillars, posts, wordmark, image: blogCard.og.dark }),
  );
  await emit(path.join(DIST, "blog", "feed.xml"), feedXml(posts, pillars));

  // 3. a share card for every hand-authored page, from its own <title> and
  //    description; the page in dist/ is pointed at it, the source untouched
  for (const rel of await htmlPages(DIST)) {
    const file = path.join(DIST, rel);
    const html = await readFile(file, "utf8");
    const { title, description } = pageMeta(html);
    if (!title) {
      throw new ContentError(
        "page has no <title> to put on its share card",
        rel,
      );
    }
    const key = pageKey(rel);
    for (const theme of THEMES) {
      const card = ogSvg({
        seed: `page:${key}`,
        theme,
        title: cardTitle(title),
        summary: description,
        kind: pageKind(rel),
        meta: [],
      });
      await emit(
        path.join(DIST, "og", `${key}-${theme}.png`),
        renderPng(card, { width: OG.w }),
      );
    }
    images += 2;
    await writeFile(
      file,
      withOgImage(html, {
        url: `${SITE}/og/${key}-dark.png`,
        width: OG.w,
        height: OG.h,
        alt: title,
      }),
    );
  }

  // 4. sitemap
  const sitemap = await readFile(path.join(ROOT, "sitemap.xml"), "utf8");
  const entries = [
    { loc: SITE + urls.blog(), changefreq: "weekly" },
    ...pillars.map((p) => ({
      loc: SITE + urls.pillar(p.slug),
      changefreq: "weekly",
    })),
    ...posts.map((p) => ({
      loc: SITE + urls.post(p.slug),
      lastmod: p.updated ?? p.date,
      changefreq: "monthly",
    })),
  ];
  await emit(path.join(DIST, "sitemap.xml"), mergeSitemap(sitemap, entries));

  const summary = {
    copied,
    pillars: pillars.length,
    posts: posts.length,
    images,
    ms: Date.now() - started,
  };
  log(
    `web: copied ${summary.copied} site entries, built ${summary.posts} posts across ${summary.pillars} pillars, drew ${summary.images} images in ${summary.ms}ms → ${path.relative(process.cwd(), DIST)}`,
  );
  return summary;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  build().catch((err) => {
    console.error(
      err instanceof ContentError ? `content error: ${err.message}` : err,
    );
    process.exit(1);
  });
}
