#!/usr/bin/env node
// Verify every external URL cited in the blog content resolves. Research
// posts live or die by their references, and a hallucinated arXiv id is the
// failure mode this exists to catch. Network-bound, so it is a separate
// command (`pnpm --filter @oxagen/web-v2 check:links`) rather than part of
// `build`.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POSTS = path.join(ROOT, "content", "posts");
const CONCURRENCY = 6;
const TIMEOUT_MS = 20_000;

/**
 * Pull every http(s) URL out of an MDX body. Trailing Markdown punctuation
 * (a closing paren or bracket, a period, a comma) is not part of the link.
 * @param {string} text
 */
export function extractUrls(text) {
  const found = new Set();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'()\[\]]+/g)) {
    found.add(m[0].replace(/[.,;:*_]+$/, ""));
  }
  return [...found];
}

/**
 * @param {string} url
 * @returns {Promise<{ url: string, ok: boolean, status: number | string }>}
 */
export async function probe(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = {
    "user-agent": "oxagen-blog-link-check/1 (+https://oxagen.sh/blog)",
  };
  try {
    let res = await fetchImpl(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers,
    });
    // Some hosts refuse HEAD; a GET settles it.
    if (res.status === 405 || res.status === 403 || res.status === 404) {
      res = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers,
      });
    }
    return { url, ok: res.ok, status: res.status };
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

export async function main() {
  const perFile = new Map();
  for (const dir of await readdir(POSTS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(POSTS, dir.name, "index.mdx");
    const text = await readFile(file, "utf8").catch(() => "");
    for (const url of extractUrls(text)) {
      if (!perFile.has(url)) perFile.set(url, []);
      perFile.get(url).push(dir.name);
    }
  }
  const urls = [...perFile.keys()].sort();
  console.log(
    `checking ${urls.length} distinct URLs across ${new Set([...perFile.values()].flat()).size} posts`,
  );
  const results = await mapLimit(urls, (u) => probe(u), CONCURRENCY);
  const bad = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(
      `${r.ok ? "ok  " : "FAIL"} ${String(r.status).padEnd(7)} ${r.url}${r.ok ? "" : `   (${perFile.get(r.url).join(", ")})`}`,
    );
  }
  console.log(`\n${results.length - bad.length} ok, ${bad.length} failed`);
  return bad.length === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().then((code) => process.exit(code));
}
