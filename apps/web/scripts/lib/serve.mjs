// The pure pieces of the dev server: how a request path maps onto dist/ (the
// same clean-URL rules CloudFront applies in production), which MIME type a
// file gets, and which source paths a change should rebuild for.

import path from "node:path";

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
};

/** @param {string} file */
export function contentTypeFor(file) {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Candidate files for a URL path, in the order production tries them:
 * `/blog` → `blog/index.html`, then `blog.html`; `/` → `index.html`;
 * `/assets/x.css` → itself. Traversal outside the root is refused.
 * @param {string} urlPath the pathname of the request
 * @returns {string[]} dist-relative candidates, or [] if the path is unsafe
 */
export function candidatesFor(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return [];
  }
  // refuse any `..` segment before normalising: `/blog/../../x` would
  // otherwise collapse to `/x` and look innocent
  if (decoded.includes("\0") || decoded.split("/").includes("..")) return [];
  const normalized = path.posix.normalize(decoded);
  if (!normalized.startsWith("/")) return [];
  const rel = normalized.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/"))
    return [path.posix.join(rel, "index.html")];
  if (path.posix.extname(rel)) return [rel];
  return [path.posix.join(rel, "index.html"), `${rel}.html`];
}

/**
 * Source paths (relative to apps/web) whose change means dist/ is stale.
 * Everything the build reads counts; its own output and tooling do not.
 * @param {string} rel
 */
export function shouldRebuild(rel) {
  const first = rel.split(/[\\/]/)[0];
  if (["dist", "node_modules", "coverage", "scripts"].includes(first))
    return false;
  if (rel.split(/[\\/]/).some((seg) => seg.startsWith("."))) return false;
  return true;
}
