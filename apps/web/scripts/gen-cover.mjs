#!/usr/bin/env node
// Generate a post's cover art: content/posts/<slug>/index.mdx's frontmatter
// pillar seeds a deterministic hex-lattice SVG (scripts/lib/cover-art.mjs),
// rasterised to assets/blog/posts/<slug>/cover.{svg,png}.
//
// Usage:
//   node scripts/gen-cover.mjs <slug>       one post
//   node scripts/gen-cover.mjs --all        every non-draft post
//
// Needs rsvg-convert (`brew install librsvg`), same as the house brand kit.

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadPillars, parseFrontmatter, validatePost } from "./lib/content.mjs";
import { coverSvg } from "./lib/cover-art.mjs";
import { loadPosts, CONTENT, ROOT } from "./build.mjs";

const run = promisify(execFile);

/** @param {string} slug @param {string} pillar */
async function generateOne(slug, pillar) {
  const svg = coverSvg({ slug, pillar });
  const dir = path.join(ROOT, "assets/blog/posts", slug);
  await mkdir(dir, { recursive: true });
  const svgPath = path.join(dir, "cover.svg");
  const pngPath = path.join(dir, "cover.png");
  await writeFile(svgPath, svg);
  await run("rsvg-convert", [
    svgPath,
    "--width",
    "1600",
    "--height",
    "900",
    "-o",
    pngPath,
  ]);
  console.log(`[cover] /assets/blog/posts/${slug}/cover.png`);
}

async function main() {
  const args = process.argv.slice(2);
  const pillars = loadPillars(
    await readFile(path.join(CONTENT, "pillars.yaml"), "utf8"),
  );

  if (args[0] === "--all") {
    const posts = await loadPosts({ pillars, includeDrafts: true });
    for (const post of posts) {
      await generateOne(post.slug, post.pillars[0]);
    }
    return;
  }

  const slug = args[0];
  if (!slug) {
    console.error("usage: node scripts/gen-cover.mjs <slug> | --all");
    process.exitCode = 1;
    return;
  }
  const file = path.join(CONTENT, "posts", slug, "index.mdx");
  const source = await readFile(file, "utf8");
  const rel = path.relative(ROOT, file);
  const { data } = parseFrontmatter(source, rel);
  const meta = validatePost(data, { slug, pillars, file: rel });
  await generateOne(slug, meta.pillars[0]);
}

if (
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  main().catch((err) => {
    console.error(err?.stack ?? err);
    process.exitCode = 1;
  });
}
