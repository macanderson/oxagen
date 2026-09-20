#!/usr/bin/env node
/**
 * Build both editions of the book, and the migration that ships them, from
 * one manuscript.
 *
 * The book is "Engineering Deterministic AI Coding Agents". It has two
 * editions: a scrolling field manual and a page-flip reader with a PDF
 * export. Until the second edition each edition held its own copy of the
 * text, so a fix to one left the other stale. The manuscript under
 * packages/database/seed-assets/books/manuscript/ is now the only place the
 * text lives:
 *
 *   book.json            title, metadata and the ordered list of sections
 *   <section>.html       the inner HTML of one section
 *   shells/*.shell.html  each edition's page, styles and script, with
 *                        {{PLACEHOLDERS}} where the manuscript goes
 *   assets/              the author photo as a data URI
 *
 * Running this script writes three files:
 *
 *   seed-assets/books/field-manual.html      read by seed-book-editions.ts
 *   seed-assets/books/page-flip-reader.html  read by seed-book-editions.ts
 *   atlas/migrations/<MIGRATION_NAME>        the only path to production,
 *                                            which runs `atlas migrate apply`
 *                                            and never the Node seed
 *
 * After it runs, rehash from packages/database:
 *
 *   atlas migrate hash --dir "file://atlas/migrations"
 *
 * build-book-editions.test.ts rebuilds in memory and fails when a committed
 * output differs from what the manuscript produces, and when the manuscript
 * breaks the prose rules in .claude/skills/clear-prose.
 *
 *   node tools/scripts/build-book-editions.mjs          write the outputs
 *   node tools/scripts/build-book-editions.mjs --check  exit 1 if any is stale
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const DB_DIR = join(REPO_ROOT, "packages", "database");
export const BOOKS_DIR = join(DB_DIR, "seed-assets", "books");
export const MANUSCRIPT_DIR = join(BOOKS_DIR, "manuscript");
export const MIGRATION_NAME = "20260920150000_book_second_edition.sql";
export const MIGRATION_FILE = join(
  DB_DIR,
  "atlas",
  "migrations",
  MIGRATION_NAME,
);

/** Dollar-quote tag for the embedded HTML. No quote in the book can need escaping. */
export const DOLLAR_TAG = "oxagen_book_html";

/** Where the reader edition loads the author photo from. The field manual inlines it. */
export const AUTHOR_PHOTO_URL =
  "/research/deterministic-systems-optimizations-for-ai-agents/author.jpg";

export const EDITIONS = [
  {
    slug: "field-manual",
    file: "field-manual.html",
    shell: "field-manual.shell.html",
    title: "Engineering Deterministic AI Coding Agents: field manual",
  },
  {
    slug: "page-flip-reader",
    file: "page-flip-reader.html",
    shell: "page-flip-reader.shell.html",
    title: "Engineering Deterministic AI Coding Agents: reader",
  },
];

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** Escape text for an HTML text node or a double-quoted attribute. */
export function esc(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Parts are numbered in the order they appear: p1 is part 1. */
export function partNumber(section) {
  const m = /^p(\d+)$/.exec(section.id);
  return m ? Number(m[1]) : null;
}

/** "Part 07" for a part, the section's mark for front and back matter. */
export function kickerNum(section) {
  const n = partNumber(section);
  return n === null ? section.mark : `Part ${String(n).padStart(2, "0")}`;
}

/** The chapter title is the text of the fragment's first ch-title heading. */
export function titleOf(section, inner) {
  if (section.title) return section.title;
  const m = /<h2 class="ch-title">([\s\S]*?)<\/h2>/.exec(inner);
  if (!m) {
    throw new Error(`section "${section.id}" has no <h2 class="ch-title">`);
  }
  return decodeEntities(m[1].replace(/<[^>]+>/g, "").trim());
}

function decodeEntities(text) {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

/** Drop the blocks only the field manual can run, such as the calculator. */
export function stripFieldManualOnly(html) {
  return html.replace(
    /[ \t]*<!-- fm-only -->[\s\S]*?<!-- \/fm-only -->[ \t]*\n?/g,
    "",
  );
}

/** Keep the blocks, drop the markers. */
export function unwrapFieldManualOnly(html) {
  return html.replace(/[ \t]*<!-- \/?fm-only -->[ \t]*\n?/g, "");
}

function navLabel(section) {
  const n = partNumber(section);
  return n === null ? section.toc : `Part ${n}: ${section.toc}`;
}

/** The previous and next links under each field-manual section. */
export function renderChapterNav(sections, index) {
  const prev = sections[index - 1];
  const next = sections[index + 1];
  const left = prev
    ? `<a href="#${prev.id}">&larr; ${esc(navLabel(prev))}</a>`
    : "<span></span>";
  const right = next
    ? `<a href="#${next.id}">${esc(navLabel(next))} &rarr;</a>`
    : "<span></span>";
  return `  <div class="ch-nav">${left}${right}</div>`;
}

/** Wrap one fragment in its <section>, with the kicker the fragment omits. */
export function renderSection(section, inner, { nav = "" } = {}) {
  const body = inner.trimEnd();
  if (section.kind === "cover") {
    return `<section id="${section.id}">\n${body}\n</section>`;
  }
  const label = section.kind === "part" ? section.group : section.kicker;
  const kicker =
    `  <div class="ch-kicker"><span class="num">${esc(kickerNum(section))}</span>` +
    `<span class="rule"></span><span>${esc(label)}</span></div>`;
  const tail = nav ? `\n${nav}` : "";
  return `<section class="ch" id="${section.id}">\n${kicker}\n${body}${tail}\n</section>`;
}

/** The field manual's sidebar: one link per section, a heading per group. */
export function renderChapnav(sections) {
  const lines = ['<nav id="chapnav">'];
  let group = null;
  for (const s of sections) {
    const n = partNumber(s);
    if (s.kind === "part" && s.group !== group) {
      group = s.group;
      lines.push(`    <div class="toc-sec">${esc(group)}</div>`);
    }
    if (s.kind !== "part" && group !== null) {
      group = null;
      lines.push('    <div class="toc-sec">Back of the book</div>');
    }
    const num = n === null ? s.mark : String(n).padStart(2, "0");
    lines.push(
      `    <a href="#${s.id}"><span class="n">${esc(num)}</span> ${esc(s.toc)}</a>`,
    );
  }
  lines.push("  </nav>");
  return lines.join("\n");
}

/** What the page-flip reader builds its contents list and PDF export from. */
export function renderManifest(sections, inners) {
  return sections.map((s) => ({
    id: s.id,
    num: s.kind === "cover" ? "" : kickerNum(s).toUpperCase(),
    kicker: s.kind === "part" ? s.group.toUpperCase() : "",
    title: titleOf(s, inners[s.id]),
  }));
}

/** JSON safe to sit inside a <script>: a "</script>" in a title cannot close it. */
export function scriptJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function fill(shell, values) {
  let out = shell;
  for (const [key, value] of Object.entries(values)) {
    out = out.replaceAll(`{{${key}}}`, () => value);
  }
  const left = out.match(/\{\{[A-Z_]+\}\}/);
  if (left) throw new Error(`shell placeholder ${left[0]} was never filled`);
  return out;
}

// ---------------------------------------------------------------------------
// Editions
// ---------------------------------------------------------------------------

/**
 * Build both editions.
 *
 * @param {object} input
 * @param {object} input.book      parsed book.json
 * @param {Record<string,string>} input.inners  section id to fragment HTML
 * @param {Record<string,string>} input.shells  shell file name to shell HTML
 * @param {string} input.photo     the author photo as a data URI
 * @returns {Record<string,string>} edition slug to finished HTML
 */
export function buildEditions({ book, inners, shells, photo }) {
  const sections = book.sections;
  const parts = sections.filter((s) => s.kind === "part").length;

  const manual = sections
    .map((s, i) =>
      renderSection(
        s,
        unwrapFieldManualOnly(inners[s.id]).replaceAll(
          "{{AUTHOR_PHOTO}}",
          photo,
        ),
        { nav: renderChapterNav(sections, i) },
      ),
    )
    .join("\n\n");

  const reader = sections
    .map((s) =>
      renderSection(
        s,
        stripFieldManualOnly(inners[s.id]).replaceAll(
          "{{AUTHOR_PHOTO}}",
          AUTHOR_PHOTO_URL,
        ),
      ),
    )
    .join("\n\n");

  const printTitle =
    `<div class="ptitle">` +
    `<div class="pt-eyebrow">A field manual · ${esc(book.edition)}</div>` +
    `<h1>${esc(book.title)}</h1>` +
    `<p class="pt-sub">${esc(book.printSubtitle)}</p>` +
    `<div class="pt-rule"></div>` +
    `<div class="pt-author">${esc(book.author)}</div>` +
    `<div class="pt-role">${esc(book.authorRole)}</div>` +
    `<div class="pt-pub">${esc(book.publisher)}</div>` +
    `</div>`;

  return {
    "field-manual": fill(shells["field-manual.shell.html"], {
      HEAD_TITLE: esc(book.headTitle["field-manual"]),
      OG_TITLE: esc(book.ogTitle),
      META_DESCRIPTION: esc(book.description),
      TOC_BRAND: esc(book.tocBrand),
      BOOK_TITLE: esc(book.title),
      CHAPNAV: renderChapnav(sections),
      CONTENT: manual,
    }),
    "page-flip-reader": fill(shells["page-flip-reader.shell.html"], {
      HEAD_TITLE: esc(book.headTitle["page-flip-reader"]),
      OG_TITLE: esc(book.ogTitle),
      OG_DESCRIPTION: esc(book.description),
      META_DESCRIPTION: esc(book.description),
      BOOK_TITLE: esc(book.title),
      BOOK_TITLE_JSON: scriptJson(book.title),
      AUTHOR: esc(book.author),
      PARTS_ONLY_LABEL: `Parts 1 to ${parts} only`,
      PRINT_TITLE_JSON: scriptJson(printTitle),
      MANIFEST: scriptJson(renderManifest(sections, inners)),
      CONTENT: reader,
    }),
  };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

const MIGRATION_HEADER = `-- Ship the second edition of the book to production.
--
-- 20260919131000 seeded cms.book_editions with the first edition, and
-- 20260919150000 patched the reader. Production takes book HTML only from
-- migrations: infra/tools/run-db-migrations.sh runs \`atlas migrate apply\`
-- and never the Node seed (packages/database/src/seed-book-editions.ts), so
-- an edit to seed-assets/books/*.html reaches a laptop and CI through
-- \`pnpm db:migrate\` and stops there. This migration carries the same two
-- files to production.
--
-- GENERATED by tools/scripts/build-book-editions.mjs from
-- packages/database/seed-assets/books/manuscript/. Do not edit it by hand:
-- change the manuscript, run the script, then rehash with
-- \`atlas migrate hash --dir "file://atlas/migrations"\` from packages/database.
-- tools/scripts/build-book-editions.test.ts fails when this file and the
-- manuscript disagree.
--
-- UPDATE, not INSERT: 20260919131000 created both rows. A row an operator
-- has unpublished stays unpublished, because \`published\` is not touched.

`;

/** One UPDATE per edition, the HTML dollar-quoted. */
export function renderEditionUpdate(edition, html) {
  const tag = `$${DOLLAR_TAG}$`;
  if (html.includes(tag)) {
    throw new Error(
      `dollar-quote tag ${tag} appears in the "${edition.slug}" HTML. Pick another DOLLAR_TAG.`,
    );
  }
  return (
    `UPDATE cms.book_editions\n` +
    `SET\n` +
    `  title = '${edition.title.replaceAll("'", "''")}',\n` +
    `  html = ${tag}${html}${tag},\n` +
    `  updated_at = now()\n` +
    `WHERE slug = '${edition.slug}';\n`
  );
}

export function renderMigration(built) {
  return (
    MIGRATION_HEADER +
    EDITIONS.map((e) => renderEditionUpdate(e, built[e.slug])).join("\n")
  );
}

// ---------------------------------------------------------------------------
// Prose rules
// ---------------------------------------------------------------------------

/** Words the house style bans outright. None has a second, legitimate use in this book. */
export const BANNED_WORDS = [
  "seamless",
  "seamlessly",
  "robust",
  "powerful",
  "revolutionary",
  "cutting-edge",
  "next-generation",
  "game-changing",
  "best-in-class",
  "world-class",
  "enterprise-grade",
  "holistic",
  "turnkey",
  "frictionless",
  "effortless",
  "leverage",
  "leverages",
  "leveraging",
  "utilize",
  "utilizes",
  "guardrail",
  "guardrails",
  "AI-powered",
  "very",
  "really",
  "truly",
  "genuinely",
  "incredibly",
  "extremely",
  "vibes",
  "rogue",
  "unchecked",
];

/** The text a reader sees: tags, entities and code removed. */
export function readerText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(pre|code|svg|script|style)\b[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/g, " ");
}

/**
 * Check one fragment against the clear-prose rules a script can check.
 * Returns one message per violation. An empty list is a pass.
 *
 * Dashes are checked across the whole fragment, code samples included. The
 * banned words and the exclamation point are checked in prose only, because
 * `!=` is code and a source's own title is not ours to reword (refs.html is
 * skipped for words by the caller for that reason).
 */
export function lintProse(name, html, { words = true } = {}) {
  const problems = [];
  const dash = html.match(/[—–]/g);
  if (dash) {
    problems.push(`${name}: ${dash.length} em or en dash(es)`);
  }
  const text = readerText(html);
  if (/(^|[^-])--([^->]|$)/.test(text)) {
    problems.push(`${name}: a double hyphen stands in for a dash`);
  }
  if (text.includes("!")) problems.push(`${name}: an exclamation point`);
  if (text.includes(";")) {
    problems.push(`${name}: a semicolon in prose (make it two sentences)`);
  }
  if (words) {
    for (const word of BANNED_WORDS) {
      const re = new RegExp(`(^|[^A-Za-z-])${word}([^A-Za-z-]|$)`, "i");
      if (re.test(text)) problems.push(`${name}: the word "${word}"`);
    }
  }
  return problems;
}

/**
 * Check the markup rules a fragment has to keep so both editions render it.
 * Returns one message per violation.
 *
 * - A part carries all five fixed blocks: title, thesis, checklist, metrics,
 *   takeaway. The checklist and the metrics are what the second edition added,
 *   and a part without them is a part the reader cannot act on.
 * - A table sits in a .tablewrap, or it overflows a phone-width field manual.
 * - A citation points at a reference that exists.
 */
export function lintStructure(section, html, refsHtml) {
  const problems = [];
  if (section.kind === "part") {
    const required = [
      ['<h2 class="ch-title">', "a title"],
      ['<p class="ch-thesis">', "a thesis"],
      ['<div class="todo">', 'a "Do this week" block'],
      ['<div class="measure">', 'a "Measure it" block'],
      ['<div class="takeaway">', "a takeaway"],
    ];
    for (const [needle, label] of required) {
      if (!html.includes(needle)) {
        problems.push(`${section.file}: missing ${label}`);
      }
    }
  }
  for (const m of html.matchAll(/<table\b/g)) {
    const before = html.slice(Math.max(0, m.index - 40), m.index);
    if (!before.includes('class="tablewrap">')) {
      problems.push(`${section.file}: a table outside <div class="tablewrap">`);
    }
  }
  for (const m of html.matchAll(/href="#(r\d+)"/g)) {
    if (!refsHtml.includes(`id="${m[1]}"`)) {
      problems.push(`${section.file}: cites #${m[1]}, which refs.html lacks`);
    }
  }
  return problems;
}

/** Every prose and structure problem in a manuscript. An empty list is a pass. */
export function lintManuscript(manuscript) {
  const refsHtml = manuscript.inners.refs ?? "";
  return manuscript.book.sections.flatMap((s) => [
    ...lintProse(s.file, manuscript.inners[s.id], { words: s.id !== "refs" }),
    ...lintStructure(s, manuscript.inners[s.id], refsHtml),
  ]);
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

export function loadManuscript(dir = MANUSCRIPT_DIR) {
  const book = JSON.parse(readFileSync(join(dir, "book.json"), "utf8"));
  /** @type {Record<string, string>} */
  const inners = {};
  for (const s of book.sections) {
    inners[s.id] = readFileSync(join(dir, s.file), "utf8");
  }
  /** @type {Record<string, string>} */
  const shells = {};
  for (const e of EDITIONS) {
    shells[e.shell] = readFileSync(join(dir, "shells", e.shell), "utf8");
  }
  const photo = readFileSync(
    join(dir, "assets", "author-photo.datauri"),
    "utf8",
  ).trim();
  return { book, inners, shells, photo };
}

/** Every output file and the content the manuscript says it should hold. */
export function expectedOutputs(manuscript = loadManuscript()) {
  const built = buildEditions(manuscript);
  const outputs = EDITIONS.map((e) => ({
    path: join(BOOKS_DIR, e.file),
    content: built[e.slug],
  }));
  outputs.push({ path: MIGRATION_FILE, content: renderMigration(built) });
  return outputs;
}

function isDirectRun() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const check = process.argv.includes("--check");
  const manuscript = loadManuscript();
  const problems = lintManuscript(manuscript);
  for (const p of problems) process.stderr.write(`manuscript: ${p}\n`);

  let stale = 0;
  for (const { path, content } of expectedOutputs(manuscript)) {
    if (check) {
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {
        current = "";
      }
      if (current !== content) {
        stale += 1;
        process.stderr.write(`stale: ${path}\n`);
      }
    } else {
      writeFileSync(path, content);
      process.stdout.write(`wrote ${path} (${content.length} bytes)\n`);
    }
  }
  if (stale > 0) {
    process.stderr.write(
      "Run `node tools/scripts/build-book-editions.mjs`, then rehash the migrations.\n",
    );
  }
  process.exit(problems.length > 0 || stale > 0 ? 1 : 0);
}
