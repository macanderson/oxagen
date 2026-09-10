#!/usr/bin/env node
// Verify every external URL cited in the blog content resolves. Research
// posts live or die by their references, and a hallucinated arXiv id or DOI
// is the failure mode this exists to catch. Network-bound, so it is a
// separate command (`pnpm --filter @oxagen/web-v2 check:links`) rather than
// part of `build`.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const POSTS_DIR = path.join(ROOT, "content", "posts");
const CONCURRENCY = 6;
const TIMEOUT_MS = 20_000;
const USER_AGENT = "oxagen-blog-link-check/1 (+https://oxagen.sh/blog)";

/**
 * Pull every http(s) URL out of an MDX body. Trailing Markdown punctuation
 * (a closing paren or bracket, a period, a comma) is not part of the link.
 * @param {string} text
 */
export function extractUrls(text) {
  const found = new Set();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'()[\]]+/g)) {
    found.add(m[0].replace(/[.,;:*_]+$/, ""));
  }
  return [...found];
}

/**
 * The DOI inside a publisher or doi.org URL, if there is one.
 * @param {string} url
 */
export function doiOf(url) {
  const m = /10\.\d{4,9}\/[^\s?#]+/.exec(url);
  return m ? m[0] : null;
}

/**
 * Does the URL resolve? Publishers such as ACM answer every scripted client
 * with 403 whether or not the DOI exists, so a 403 on a DOI URL is settled by
 * Crossref's metadata API instead: it returns 200 for a registered DOI and
 * 404 for an unknown one.
 * @param {string} url
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ url: string, ok: boolean, status: number | string, via?: string }>}
 */
export async function probe(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const opts = {
    redirect: "follow",
    signal: controller.signal,
    headers: { "user-agent": USER_AGENT },
  };
  try {
    let res = await fetchImpl(url, { ...opts, method: "HEAD" });
    // Some hosts refuse HEAD; a GET settles it.
    if (res.status === 405 || res.status === 403 || res.status === 404) {
      res = await fetchImpl(url, { ...opts, method: "GET" });
    }
    if (res.ok) return { url, ok: true, status: res.status };
    const doi = res.status === 403 ? doiOf(url) : null;
    if (doi) {
      const meta = await fetchImpl(
        `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
        { ...opts, method: "GET" },
      );
      return { url, ok: meta.ok, status: meta.status, via: "crossref" };
    }
    return { url, ok: false, status: res.status };
  } catch (err) {
    return {
      url,
      ok: false,
      status:
        err?.name === "AbortError" ? "timeout" : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @template T, R
 * @param {T[]} items
 * @param {(item: T) => Promise<R>} fn
 * @param {number} limit
 */
export async function mapLimit(items, fn, limit) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Every distinct URL across the posts, with the post slugs that cite it.
 * @param {string} postsDir
 * @returns {Promise<Map<string, string[]>>}
 */
export async function collectUrls(postsDir) {
  const perFile = new Map();
  for (const dir of await readdir(postsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(postsDir, dir.name, "index.mdx");
    const text = await readFile(file, "utf8").catch(() => "");
    for (const url of extractUrls(text)) {
      if (!perFile.has(url)) perFile.set(url, []);
      perFile.get(url).push(dir.name);
    }
  }
  return perFile;
}

/**
 * @param {{ postsDir?: string, fetchImpl?: typeof fetch, log?: (line: string) => void }} [o]
 * @returns {Promise<number>} the exit code
 */
export async function main({
  postsDir = POSTS_DIR,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const perFile = await collectUrls(postsDir);
  const urls = [...perFile.keys()].sort();
  const postCount = new Set([...perFile.values()].flat()).size;
  log(`checking ${urls.length} distinct URLs across ${postCount} posts`);
  const results = await mapLimit(urls, (u) => probe(u, fetchImpl), CONCURRENCY);
  const bad = results.filter((r) => !r.ok);
  for (const r of results) {
    const tag = r.ok ? "ok  " : "FAIL";
    const via = r.via ? ` via ${r.via}` : "";
    const cited = r.ok ? "" : `   (${perFile.get(r.url).join(", ")})`;
    log(`${tag} ${String(r.status).padEnd(7)} ${r.url}${via}${cited}`);
  }
  log(`\n${results.length - bad.length} ok, ${bad.length} failed`);
  return bad.length === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().then((code) => process.exit(code));
}
