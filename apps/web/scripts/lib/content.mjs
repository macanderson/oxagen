// Content model for the blog: pillars from content/pillars.yaml, posts from
// content/posts/<slug>/index.mdx. Pure functions over strings and plain
// objects so the build's rules (what a valid pillar is, what a valid post is,
// how they link) are testable without touching the filesystem.

import { parse as parseYaml } from "yaml";
import { TREATMENTS } from "./art.mjs";

export class ContentError extends Error {
  /** @param {string} message @param {string} [file] */
  constructor(message, file) {
    super(file ? `${file}: ${message}` : message);
    this.name = "ContentError";
    this.file = file;
  }
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse and validate the pillars file. Returns pillars sorted by `order`.
 * @param {string} yamlText
 * @param {string} [file]
 */
export function loadPillars(yamlText, file = "content/pillars.yaml") {
  const doc = parseYaml(yamlText);
  if (!doc || !Array.isArray(doc.pillars) || doc.pillars.length === 0) {
    throw new ContentError("expected a non-empty `pillars:` list", file);
  }
  const seen = new Set();
  const pillars = doc.pillars.map((raw, i) => {
    const where = `pillars[${i}]`;
    for (const key of ["slug", "name", "tagline", "description"]) {
      if (!isNonEmptyString(raw?.[key])) {
        throw new ContentError(`${where}: \`${key}\` is required`, file);
      }
    }
    if (!SLUG.test(raw.slug)) {
      throw new ContentError(
        `${where}: slug "${raw.slug}" must be kebab-case`,
        file,
      );
    }
    if (seen.has(raw.slug)) {
      throw new ContentError(`${where}: duplicate slug "${raw.slug}"`, file);
    }
    seen.add(raw.slug);
    if (typeof raw.order !== "number" || !Number.isInteger(raw.order)) {
      throw new ContentError(`${where}: \`order\` must be an integer`, file);
    }
    const treatment = raw.treatment ?? null;
    if (treatment !== null && !TREATMENTS.includes(treatment)) {
      throw new ContentError(
        `${where}: \`treatment\` must be one of ${TREATMENTS.join(", ")}`,
        file,
      );
    }
    return {
      slug: raw.slug,
      name: raw.name.trim(),
      tagline: raw.tagline.trim(),
      description: raw.description.trim(),
      order: raw.order,
      treatment,
    };
  });
  return pillars.sort(
    (a, b) => a.order - b.order || a.slug.localeCompare(b.slug),
  );
}

/**
 * Split an MDX file into its YAML frontmatter and body.
 * @param {string} source
 * @param {string} [file]
 * @returns {{ data: Record<string, unknown>, body: string }}
 */
export function parseFrontmatter(source, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) {
    throw new ContentError("missing YAML frontmatter block", file);
  }
  const data = parseYaml(match[1]);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ContentError("frontmatter must be a YAML mapping", file);
  }
  return { data, body: source.slice(match[0].length) };
}

/**
 * Words per minute for the reading-time estimate. 230 is the median adult
 * silent-reading rate for non-fiction English (Brysbaert 2019, J. Memory &
 * Language), which is what every "N min read" label uses.
 */
export const WORDS_PER_MINUTE = 230;

/**
 * Count prose words in an MDX body: code fences, JSX tags, footnote
 * definitions, and Markdown punctuation are dropped so a long reference list
 * does not inflate the estimate.
 * @param {string} body
 */
export function countWords(body) {
  const stripped = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\[\^[^\]]+\]:.*$/gm, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/[|#*_`>\-]+/g, " ");
  return stripped.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/** @param {number} words */
export function readingMinutes(words) {
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

/**
 * Validate a post's frontmatter against the pillar list and normalise it.
 * @param {Record<string, unknown>} data
 * @param {{ slug: string, pillars: Array<{slug: string}>, file?: string }} ctx
 */
export function validatePost(data, { slug, pillars, file }) {
  if (!SLUG.test(slug)) {
    throw new ContentError(`post folder "${slug}" must be kebab-case`, file);
  }
  for (const key of ["title", "description"]) {
    if (!isNonEmptyString(data[key])) {
      throw new ContentError(`\`${key}\` is required`, file);
    }
  }
  const description = String(data.description).trim();
  if (description.length > 200) {
    throw new ContentError(
      `\`description\` is ${description.length} chars; keep it under 200 for the meta tag`,
      file,
    );
  }
  const date =
    data.date instanceof Date
      ? data.date.toISOString().slice(0, 10)
      : String(data.date ?? "");
  if (!ISO_DATE.test(date)) {
    throw new ContentError("`date` must be an ISO date (YYYY-MM-DD)", file);
  }
  const updated =
    data.updated == null
      ? null
      : data.updated instanceof Date
        ? data.updated.toISOString().slice(0, 10)
        : String(data.updated);
  if (updated !== null && !ISO_DATE.test(updated)) {
    throw new ContentError("`updated` must be an ISO date (YYYY-MM-DD)", file);
  }
  if (!Array.isArray(data.pillars) || data.pillars.length === 0) {
    throw new ContentError(
      "`pillars` must list at least one pillar slug",
      file,
    );
  }
  const known = new Set(pillars.map((p) => p.slug));
  const postPillars = data.pillars.map((p) => {
    if (!isNonEmptyString(p) || !known.has(p)) {
      throw new ContentError(
        `unknown pillar "${p}" (define it in content/pillars.yaml)`,
        file,
      );
    }
    return p;
  });
  if (new Set(postPillars).size !== postPillars.length) {
    throw new ContentError("`pillars` lists the same pillar twice", file);
  }
  const authors = Array.isArray(data.authors) ? data.authors.map(String) : [];
  if (authors.length === 0) {
    throw new ContentError("`authors` must list at least one author", file);
  }
  const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
  for (const tag of tags) {
    if (!SLUG.test(tag)) {
      throw new ContentError(`tag "${tag}" must be kebab-case`, file);
    }
  }
  const image = data.image == null ? null : String(data.image);
  if (image !== null && !image.startsWith("/")) {
    throw new ContentError("`image` must be a site-absolute path", file);
  }
  return {
    slug,
    title: String(data.title).trim(),
    description,
    date,
    updated,
    pillars: postPillars,
    authors,
    tags,
    image,
    draft: data.draft === true,
  };
}

/**
 * Newest first, then title, so the order is stable across builds.
 * @template {{date: string, title: string}} T
 * @param {T[]} posts
 */
export function sortPosts(posts) {
  return [...posts].sort(
    (a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title),
  );
}

/**
 * Group posts under every pillar they link to. A post with two pillars shows
 * up under both; pillars with no posts still get an (empty) entry so every
 * pillar page is built.
 * @template {{pillars: string[]}} P
 * @param {Array<{slug: string}>} pillars
 * @param {P[]} posts
 * @returns {Map<string, P[]>}
 */
export function groupByPillar(pillars, posts) {
  const groups = new Map(pillars.map((p) => [p.slug, []]));
  for (const post of posts) {
    for (const slug of post.pillars) {
      groups.get(slug)?.push(post);
    }
  }
  return groups;
}

/**
 * Posts that share a pillar with `post`, excluding itself, primary-pillar
 * matches first.
 * @template {{slug: string, pillars: string[], date: string, title: string}} P
 * @param {P} post
 * @param {P[]} all
 * @param {number} limit
 */
export function relatedPosts(post, all, limit = 3) {
  const primary = post.pillars[0];
  const scored = all
    .filter((other) => other.slug !== post.slug)
    .map((other) => {
      const shared = other.pillars.filter((p) =>
        post.pillars.includes(p),
      ).length;
      const primaryHit = other.pillars.includes(primary) ? 1 : 0;
      return { other, score: shared * 2 + primaryHit };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.other.date.localeCompare(a.other.date) ||
        a.other.title.localeCompare(b.other.title),
    );
  return scored.slice(0, limit).map(({ other }) => other);
}
