// The hand-authored pages' share cards. A page is copied to dist/ verbatim;
// the build then reads its <title> and description, renders an Open Graph
// card for it, and points the copy's og:image at that card. The source page
// is never touched, so a page needs no build step of its own to get a card.

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  "#x27": "'",
};

/** @param {string} s */
export function decodeEntities(s) {
  return s.replace(/&(#x27|#39|amp|lt|gt|quot|apos);/g, (_, k) => ENTITIES[k]);
}

const attr = (html, re) => {
  const m = html.match(re);
  return m ? decodeEntities(m[1]).trim() : "";
};

/**
 * The title and description a page declares, as a crawler would read them.
 * @param {string} html
 */
export function pageMeta(html) {
  return {
    title: attr(html, /<title>([\s\S]*?)<\/title>/i),
    description: attr(html, /<meta\s+name="description"\s+content="([^"]*)"/i),
  };
}

/**
 * A page's title as it should read on its card: the site's name comes off
 * the end, since the wordmark is already on the card.
 * @param {string} title
 */
export function cardTitle(title) {
  return title.replace(/\s*[|—–·-]\s*Oxagen\s*$/u, "").trim() || title.trim();
}

/**
 * The card's file stem for a page path inside dist/:
 * "index.html" → "index", "products/stella/index.html" → "products-stella".
 * @param {string} rel
 */
export function pageKey(rel) {
  const parts = rel
    .replace(/\\/g, "/")
    .replace(/\.html$/, "")
    .split("/");
  if (parts.length > 1 && parts.at(-1) === "index") parts.pop();
  return parts.join("-");
}

/**
 * The eyebrow on a page's card: the section it lives in.
 * @param {string} rel
 */
export function pageKind(rel) {
  const first = rel
    .replace(/\\/g, "/")
    .split("/")[0]
    .replace(/\.html$/, "");
  if (first === "index") return "Oxagen";
  return first
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * The page with its og:image and twitter:image pointed at `url`, and the
 * card's size and alt declared beside it. Whatever image tags the page
 * declared are replaced in place; a page that declared none gets them after
 * its <title>, so every page carries a card whether or not its author
 * thought about sharing.
 * @param {string} html
 * @param {{ url: string, width: number, height: number, alt: string }} o
 */
export function withOgImage(html, o) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  const tags = [
    `<meta property="og:image" content="${esc(o.url)}">`,
    `<meta property="og:image:width" content="${o.width}">`,
    `<meta property="og:image:height" content="${o.height}">`,
    `<meta property="og:image:alt" content="${esc(o.alt)}">`,
    `<meta name="twitter:image" content="${esc(o.url)}">`,
  ].join("\n");
  const stripped = html.replace(
    /\n?[ \t]*<meta\s+(?:property="og:image(?::width|:height|:alt)?"|name="twitter:image")\s+content="[^"]*">/g,
    "",
  );
  if (!/<\/title>/i.test(stripped)) {
    throw new Error("page has no <title>, so its card has nowhere to go");
  }
  return stripped.replace(/<\/title>/i, `</title>\n${tags}`);
}
