#!/usr/bin/env node
// Prose gate for the two customer-facing sites: oxagen.sh (apps/web) and
// docs.oxagen.sh (apps/docs). The rules come from .claude/skills/clear-prose
// and .claude/skills/oxagen-branding/references/words.md; this script holds
// the subset a machine can check without reading for meaning.
//
// It fails on:
//   - an em dash, or an en dash used as a separator, in anything a customer
//     reads (the house rule: a period, a comma, a colon, or parentheses)
//   - an exclamation point in prose
//   - a word from the avoid list
//
// It skips fenced code, inline code, HTML <script>, <style>, <svg>, <pre> and
// <code>, and MDX import/export lines, because a dash in a command or a flag
// is not prose. It reads the words the reader sees, so HTML entities for the
// dash count and comments do not.
//
// Usage: node tools/scripts/check-prose.mjs [--list] [paths...]
//   --list prints every hit; default prints per-file counts and the first few.
//   With no paths it scans the two sites.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

const SCAN = [
  {
    dir: "apps/web",
    ext: [".html", ".mdx", ".md", ".yaml"],
    skip: [
      "node_modules",
      "dist",
      "coverage",
      "assets",
      "fonts",
      "scripts",
      "research-assets",
      "README.md",
      "CLAUDE.md",
    ],
  },
  { dir: "apps/docs/content", ext: [".mdx", ".md"], skip: [] },
  { dir: "apps/docs/src/app/(home)", ext: [".tsx"], skip: [] },
  // The published sales decks and the narration a presenter reads aloud. These
  // were outside the scan while the retired-line entries were added to the avoid
  // list, so the one surface that had carried a retired headline into a customer
  // meeting was the one surface the new check could not see. `.js` is here for
  // `script-data.js`, which holds the spoken script.
  { dir: "apps/docs/public/decks", ext: [".html", ".js"], skip: [] },
];

// Words that mean nothing, intensifiers, emotional and fear sells, category
// words owned by others, overclaims, and filler openers. Matched as whole
// words, case-insensitive. Words with legitimate technical uses in the docs
// (risk, protect, session, trace, verified, proven, users) are left to review.
export const AVOID = [
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
  "comprehensive",
  "holistic",
  "end-to-end",
  "turnkey",
  "frictionless",
  "effortless",
  "effortlessly",
  "magic",
  "magical",
  "very",
  "really",
  "truly",
  "genuinely",
  "incredibly",
  "extremely",
  "deeply",
  "highly",
  "super",
  "excited",
  "thrilled",
  "delighted",
  "passionate",
  "finally",
  "at last",
  "imagine",
  "rogue",
  "unchecked",
  "safeguard",
  "safeguards",
  "guardrails",
  "trust layer",
  "safety layer",
  "observability",
  "evals",
  "LLMOps",
  "AI ops",
  "guaranteed",
  "100%",
  "eliminates",
  "AI-powered",
  "LLM-powered",
  "copilot",
  "leverage",
  "leverages",
  "leveraging",
  "utilize",
  "utilizes",
  "in order to",
  "in today's",
  "as AI agents become",
  "with the rise of",
  "it's no secret",
  "we believe",
  "we're on a mission",
  // Retired lines from the positioning registry
  // (.claude/skills/oxagen-branding/references/positioning.md, "Retired").
  // Each one came back once after it was retired, so the scanner holds it.
  "never re-explain",
  "fewer tokens, same answers",
  "stop wasting money",
  "explain your ai bill",
  "mission control for your autonomous agents",
  // Retired as the product name on 2026-09-19 (ADR-113): GitHub now ships a
  // control-plane product called Mission Control. Say Oxagen for the app and
  // the operator console in prose. A citation of a document by its title
  // ("Mission Control spec", "Mission Control mockup") names a file, not the
  // product, and is allowed by CITED_AFTER below.
  "mission control",
  // Unqualified key-custody claims. positioning.md limits custody to mediated
  // connections; the agent still holds its own identity. These phrases came
  // back on the product page meta and Twitter description, so the scanner holds
  // them rather than a reviewer.
  "the agent never sees the key",
  "the key never moves",
  "nothing for the agent to leak",
];

const AVOID_RE = new RegExp(
  "(?<![\\w-])(" +
    AVOID.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")(?![\\w-])",
  "gi",
);

/** The words that turn a retired product name into a document citation. */
const CITED_AFTER = /^\s+(spec|mockup)\b/i;

/** Strip the parts of a file that are not prose, keeping line count intact. */
export function proseOf(text, ext) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  let s = text;
  if (ext === ".js") {
    // A deck's narration file (`script-data.js`) holds the spoken script in
    // exported data, so this cannot borrow the .tsx branch: that one blanks
    // `export` lines as module plumbing, which is exactly where the words are.
    // Comments go, because this script's contract is the words a reader sees
    // (see the header), and the data stays.
    s = s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
    return s;
  }
  if (ext === ".html" || ext === ".tsx") {
    s = s.replace(/<(script|style|svg|pre|code)\b[\s\S]*?<\/\1>/gi, blank);
    s = s.replace(/<!--[\s\S]*?-->/g, blank);
    if (ext === ".tsx") {
      // Only string literals and JSX text can reach a reader.
      s = s.replace(/^\s*(import|export)\b[^\n]*$/gm, blank);
      s = s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
      s = s
        .replace(/className="[^"]*"/g, blank)
        .replace(/href="[^"]*"/g, blank);
    }
    // Attribute values the reader does not see.
    s = s.replace(
      /\b(src|class|id|viewBox|d|points|style|data-[\w-]+)="[^"]*"/g,
      blank,
    );
    s = s
      .replace(/&mdash;|&#8212;|&#x2014;/g, "—")
      .replace(/&ndash;|&#8211;/g, "–");
  } else {
    s = s.replace(/^```[\s\S]*?^```/gm, blank);
    s = s.replace(/`[^`\n]*`/g, blank);
    s = s.replace(/^\s*(import|export)\b[^\n]*$/gm, blank);
    // Footnote citations quote other people's titles verbatim.
    s = s.replace(/^\[\^[^\]]+\]:[^\n]*$/gm, blank);
    s = s.replace(/<Mermaid[\s\S]*?\/>/g, blank);
    s = s.replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, blank);
  }
  return s;
}

export function findHits(text, ext) {
  const s = proseOf(text, ext);
  const lines = s.split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    if (/—/.test(line))
      hits.push({ line: i + 1, kind: "em dash", text: line.trim() });
    if (/\s–\s/.test(line))
      hits.push({
        line: i + 1,
        kind: "en dash as separator",
        text: line.trim(),
      });
    if (/[A-Za-z0-9)]!(?=\s|$|["'])/.test(line))
      hits.push({ line: i + 1, kind: "exclamation", text: line.trim() });
    for (const m of line.matchAll(AVOID_RE)) {
      const cited =
        /^mission control$/i.test(m[1]) &&
        CITED_AFTER.test(line.slice(m.index + m[1].length));
      if (cited) continue;
      hits.push({ line: i + 1, kind: `avoid: ${m[1]}`, text: line.trim() });
    }
  });
  return hits;
}

function* walk(dir, ext, skip) {
  for (const name of readdirSync(dir)) {
    if (skip.includes(name) || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p, ext, skip);
    else if (ext.includes(extname(name))) yield p;
  }
}

function main() {
  const args = process.argv.slice(2);
  const list = args.includes("--list");
  const paths = args.filter((a) => !a.startsWith("--"));
  const ALL_EXT = [".html", ".mdx", ".md", ".yaml", ".tsx", ".js"];
  const files = paths.length
    ? paths.flatMap((p) => {
        const full = join(ROOT, p);
        return statSync(full).isDirectory()
          ? [...walk(full, ALL_EXT, ["node_modules", "dist", "coverage"])]
          : [full];
      })
    : SCAN.flatMap((s) => [...walk(join(ROOT, s.dir), s.ext, s.skip)]);
  let total = 0;
  for (const f of files) {
    const hits = findHits(readFileSync(f, "utf8"), extname(f));
    if (!hits.length) continue;
    total += hits.length;
    const rel = relative(ROOT, f);
    console.log(`${rel}: ${hits.length}`);
    for (const h of list ? hits : hits.slice(0, 3)) {
      console.log(`  ${h.line}: [${h.kind}] ${h.text.slice(0, 110)}`);
    }
  }
  if (total) {
    console.error(
      `\ncheck:prose: ${total} hit(s). See .claude/skills/clear-prose/SKILL.md.`,
    );
    process.exit(1);
  }
  console.log("check:prose: clean");
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop())
)
  main();
