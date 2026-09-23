/**
 * release-notes.ts: the pure half of the release-notes step in
 * `tools/scripts/release.ts`.
 *
 * A release's notes are written by a model that reads the commit log, the
 * diffstat and the diff since the previous tag, under the two writing skills
 * this repository requires of every person: `clear-prose` (the sentences) and
 * `oxagen-branding` (the voice and the words). The skill files are read from
 * the tree at run time and handed to the model as its instructions, so the
 * rules the model follows are the rules the repository holds, not a copy that
 * drifts. What comes back is checked by the same scanner `pnpm check:prose`
 * runs on the docs, because the notes become a docs page and that page must
 * pass the gate in CI.
 *
 * The notes are a summary, not a ledger. A release page names the changes a
 * reader would want to know about, whether they are fixes or features, and
 * leaves the rest to the commit log. Honesty over completeness: nothing the
 * diff does not support, no claim stronger than the change.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findHits } from "../check-prose.mjs";

/** The skill files the model reads before it writes. */
export const SKILL_FILES = [
  ".claude/skills/clear-prose/SKILL.md",
  ".claude/skills/oxagen-branding/references/voice.md",
  ".claude/skills/oxagen-branding/references/words.md",
] as const;

export interface NotesHistory {
  fromRef: string;
  version: string;
  log: string;
  stat: string;
  diff: string;
  /** What the maintainer names as the release's headline, if anything. */
  highlight?: string | null;
}

export interface ReleaseNotes {
  /** One or two sentences: the release in the reader's terms. */
  summary: string;
  /** Markdown, headings at `##` and below, no title. */
  body: string;
}

/** Read the skill files under `root`; a missing one is an error, not a blank. */
export function loadSkills(root: string): string {
  return SKILL_FILES.map((rel) => {
    const path = join(root, rel);
    if (!existsSync(path))
      throw new Error(
        `release notes need ${rel} and it is not in the tree; the skills are the model's instructions`,
      );
    return `<skill path="${rel}">\n${readFileSync(path, "utf8").trim()}\n</skill>`;
  }).join("\n\n");
}

/** The instructions the model works under: the skills, then the job. */
export function systemPrompt(skills: string): string {
  return [
    "You write the release notes for Oxagen, workforce management for autonomous agents.",
    "Two skills govern every sentence you write. Read them first; they are your instructions.",
    "",
    skills,
    "",
    "The job:",
    "- Read the commit log, the diffstat and the diff. Write what changed for a person who operates agents under Oxagen.",
    "- Summarise. Name the changes that matter most to that reader, whether fixes or features. Do not list every commit; the log is the ledger.",
    "- Be honest. Nothing the diff does not support. No claim stronger than the change. A fix is a fix; say what was wrong and what happens now.",
    "- Plain voice. Actor first, one idea per sentence, numbers over adjectives, sentence case headings, no em dashes, no exclamation points, no words from the avoid list.",
    "- Use the product's words: run, turn, step, frame, operator, agent, workspace, mandate, request, rule, allowed, denied, routed. Never session, trace, invocation or execution in a sentence a customer reads.",
    "- Internal work (CI, tests, refactors, tooling) earns a line only when a reader would feel it. Otherwise leave it out.",
    "",
    "Output, in this exact shape and nothing else:",
    "",
    "SUMMARY: <one or two sentences, at most 220 characters, no heading, no markdown>",
    "",
    "## What changed",
    "",
    "<three to eight short paragraphs or bullets, each one change, the most important first. A change may have a `### heading` when it needs a few sentences. Reference a commit as `(abc1234)` only when a reader would look it up.>",
    "",
    "Do not add a title, a version heading, a date, a download section or a sign-off; the page around the notes carries those.",
  ].join("\n");
}

/** What the model reads for this release. */
export function userPrompt(h: NotesHistory): string {
  const highlight = h.highlight?.trim();
  return [
    `Version ${h.version}. Changes since ${h.fromRef}.`,
    "",
    ...(highlight
      ? [
          "## The headline",
          "The maintainer names this as what the release leads with. Open the summary and the first change with it, in the product's words, and claim only what the log and the diff support.",
          "",
          highlight,
          "",
        ]
      : []),
    "## Commit log",
    h.log || "(none)",
    "",
    "## Diffstat",
    h.stat || "(none)",
    "",
    "## Unified diff (may be truncated)",
    "```diff",
    h.diff || "(none)",
    "```",
  ].join("\n");
}

/**
 * Split the model's answer into the summary and the body. The shape is
 * strict so a reply that wanders (a title, a preamble, a sign-off) is
 * refused rather than published.
 */
export function parseNotes(text: string): ReleaseNotes | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, "$1");
  const m = /^SUMMARY:\s*(.+?)\s*\n+(## What changed[\s\S]*)$/i.exec(trimmed);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const summary = m[1].replace(/\s+/g, " ").trim();
  const body = m[2].trim();
  if (summary.length === 0 || body.length < 40) return null;
  return { summary, body };
}

/** The prose scanner's findings for the notes, as the model would read them. */
export function proseHits(notes: ReleaseNotes): string[] {
  const text = `${notes.summary}\n\n${notes.body}\n`;
  return findHits(text, ".md").map(
    (h: { line: number; kind: string; text: string }) =>
      `line ${h.line} [${h.kind}]: ${h.text}`,
  );
}

/** A second try, with the scanner's findings in hand. */
export function retryPrompt(notes: ReleaseNotes, hits: string[]): string {
  return [
    "Your notes fail the prose scanner the docs site runs in CI. Rewrite them so every finding below is gone, keeping the substance, the shape and the honesty.",
    "",
    "Findings:",
    ...hits.map((h) => `- ${h}`),
    "",
    "Your previous answer:",
    "",
    `SUMMARY: ${notes.summary}`,
    "",
    notes.body,
  ].join("\n");
}

/**
 * The last resort when the model cannot be reached or will not comply: a
 * summary from the commit count and the subjects, sanitised so the page
 * still passes the gate. Honest, dull, and never blocks a release.
 */
export function fallbackNotes(h: NotesHistory): ReleaseNotes {
  const subjects = h.log
    .split("\n")
    .map((l) =>
      l
        .replace(/^- /, "")
        .replace(/\s\(\w{7,}\)$/, "")
        .trim(),
    )
    .filter((l) => l.length > 0)
    .map((l) => escapeMdx(sanitizeLine(l)));
  // The mechanical fixes above cannot rewrite a subject that carries a word
  // from the avoid list ("robust", "observability"), and a page that fails
  // the gate would block the release PR, which is what the fallback exists
  // to prevent. Such a subject stays in the commit log and is counted here.
  const clean = subjects.filter(
    (l) => findHits(`- ${l}\n`, ".md").length === 0,
  );
  const count = subjects.length;
  const shown = clean.slice(0, 40);
  const omitted = count - shown.length;
  const summary =
    count === 0
      ? `Version ${h.version} carries no changes since ${h.fromRef}.`
      : `Version ${h.version} carries ${count} ${count === 1 ? "change" : "changes"} since ${h.fromRef}. The list below is the commit log; a written summary was not available for this release.`;
  const body = [
    "## What changed",
    "",
    ...(count === 0
      ? ["No commits since the previous release."]
      : shown.map((s) => `- ${s}`)),
    ...(omitted > 0 ? ["", `And ${omitted} more, in the commit log.`] : []),
  ].join("\n");
  return { summary, body };
}

/**
 * A commit subject is prose to Markdown and to MDX alike, except that MDX
 * reads `<img>` as JSX and `{value}` as an expression, and a subject such as
 * `replace <img> with <Image>` would fail the docs build. A backslash before
 * each of those characters is an escape in both, so the same text serves the
 * changelog and the page.
 */
export function escapeMdx(line: string): string {
  return line.replace(/[\\<>{}]/g, (c) => `\\${c}`);
}

/** Make one line pass the scanner's mechanical rules. */
export function sanitizeLine(line: string): string {
  return line
    .replace(/\s*[—]\s*/g, ", ")
    .replace(/\s+–\s+/g, ", ")
    .replace(/\s*--\s*/g, ", ")
    .replace(/([A-Za-z0-9)])!(?=\s|$|["'])/g, "$1.")
    .replace(/,\s*,/g, ",")
    .trim();
}

/** The docs page for one release. */
export function releasePageMdx(input: {
  version: string;
  date: string;
  notes: ReleaseNotes;
}): string {
  const description = input.notes.summary.replace(/"/g, "'");
  return [
    "---",
    `title: v${input.version}`,
    `description: "${description}"`,
    // Quoted: bare 2026-09-19 is a YAML timestamp, and the schema wants a string.
    `date: "${input.date}"`,
    "---",
    "",
    `<ReleaseDownloads version="${input.version}" />`,
    "",
    input.notes.body.trim(),
    "",
  ].join("\n");
}

/** The `releases/v*.md` file and the CHANGELOG entry share this body. */
export function changelogEntry(version: string, notes: ReleaseNotes): string {
  return `## v${version}\n\n${notes.summary}\n\n${notes.body.replace(/^## What changed\s*\n/, "").trim()}\n`;
}

/**
 * The sidebar order for the releases section: the index, then every version
 * newest first. `meta.json` lists pages by hand because Fumadocs sorts
 * unlisted pages by name, and `v2.10.0` sorts before `v2.9.0` by name.
 */
export function releasesMeta(existing: string | null, version: string): string {
  let pages: string[] = ["index"];
  if (existing !== null) {
    try {
      const parsed = JSON.parse(existing) as { pages?: unknown };
      if (Array.isArray(parsed.pages))
        pages = parsed.pages.filter((p): p is string => typeof p === "string");
    } catch {
      /* rewrite it */
    }
  }
  const versions = new Set(
    pages.filter((p) => /^v\d+\.\d+\.\d+$/.test(p)).concat(`v${version}`),
  );
  const sorted = [...versions].sort((a, b) =>
    compareSemverDesc(a.slice(1), b.slice(1)),
  );
  return `${JSON.stringify({ title: "Releases", pages: ["index", ...sorted] }, null, 2)}\n`;
}

/** Newest first. */
export function compareSemverDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
