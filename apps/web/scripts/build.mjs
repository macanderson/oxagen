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
import {
  feedXml,
  indexPage,
  inlineWordmark,
  mergeSitemap,
  pillarPage,
  postPage,
  SITE,
  urls,
} from "./lib/html.mjs";
import { renderMdx } from "./lib/mdx.mjs";

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

/** @param {string} file @param {string} content */
async function emit(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

export async function build({ log = console.log } = {}) {
  const started = Date.now();
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // 1. the hand-authored site
  let copied = 0;
  for (const name of await readdir(ROOT)) {
    if (!isPublishable(name)) continue;
    await cp(path.join(ROOT, name), path.join(DIST, name), { recursive: true });
    copied += 1;
  }

  // 2. the blog
  const pillars = loadPillars(
    await readFile(path.join(CONTENT, "pillars.yaml"), "utf8"),
  );
  for (const pillar of pillars) {
    const onDisk = path.join(ROOT, pillar.image.src.replace(/^\//, ""));
    const info = await stat(onDisk).catch(() => null);
    if (!info?.isFile())
      throw new ContentError(
        `pillar "${pillar.slug}" image ${pillar.image.src} is missing`,
        "content/pillars.yaml",
      );
  }
  const posts = await loadPosts({
    pillars,
    includeDrafts: process.env.BLOG_DRAFTS === "1",
  });
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
    indexPage({ pillars, posts, wordmark }),
  );
  await emit(path.join(DIST, "blog", "feed.xml"), feedXml(posts, pillars));

  // 3. sitemap
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
    ms: Date.now() - started,
  };
  log(
    `web: copied ${summary.copied} site entries, built ${summary.posts} posts across ${summary.pillars} pillars in ${summary.ms}ms → ${path.relative(process.cwd(), DIST)}`,
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
