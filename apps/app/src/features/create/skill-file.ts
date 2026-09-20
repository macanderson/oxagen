import { skillSourceName } from "@/shared/source-identity";

// The skill wizard's file logic (roadmap creation-spec §4; mockup
// `wzSkillSlug`, `wzSkillBody`, `wzWords`): the directory name a description
// or a bundle implies, the SKILL.md drafted from a description, and what the
// review step reads back out of the file's frontmatter. Pure, so the steps and
// their tests agree on one reading.
//
// The authoritative checks are propose_skill's (packages/oxagen/src/contracts/
// skill.propose.ts), run by its handler before anything reaches GitHub. This
// module reads the same frontmatter the same way so the review step can show
// what the checks will see, and it never decides on their behalf.

/** Words a name never takes from a description (mockup `WZ_STOP`). */
const STOP = new Set([
  "the",
  "a",
  "an",
  "to",
  "for",
  "of",
  "and",
  "or",
  "in",
  "on",
  "our",
  "we",
  "i",
  "want",
  "need",
  "that",
  "with",
  "when",
  "from",
  "by",
  "it",
  "is",
  "be",
  "can",
  "should",
  "how",
  "new",
]);

/** A skill's directory name: lowercase kebab-case, at most 48 characters (skillNameSchema). */
const NAME_MAX = 48;

/** The words of `text` a name may be built from, lowercased, in order. */
export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "" && !STOP.has(w));
}

/** Trim a kebab name to the limit without leaving a dangling hyphen. */
function fit(name: string): string {
  return name.slice(0, NAME_MAX).replace(/-+$/, "");
}

/** The directory a description implies: its first four words, kebab-case. */
export function slugFromDescription(desc: string): string {
  return fit(wordsOf(desc).slice(0, 4).join("-")) || "new-skill";
}

/** The directory a bundle's file name implies: `release-notes-2.2.0.skill` → `release-notes`. */
export function slugFromFileName(file: string): string {
  const stem = file
    .replace(/\.(skill|zip|md)$/i, "")
    .replace(/[-_.]v?\d+(\.\d+)*$/, "");
  return (
    fit(
      stem
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    ) || "new-skill"
  );
}

type Frontmatter = Readonly<Record<string, string>>;

/**
 * The `key: value` lines between a `---` first line and the next `---`, or
 * null when the file does not open with a fence or never closes one. The
 * reading propose_skill's `readSkillFrontmatter` makes.
 */
export function frontmatterOf(text: string): Frontmatter | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return null;
  const close = lines.indexOf("---", 1);
  if (close < 0) return null;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (m?.[1] !== undefined) fields[m[1]] = (m[2] ?? "").trim();
  }
  return fields;
}

/** A plain `major.minor.patch`, the only version the version check accepts. */
export function isSemver(v: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v.trim());
}

/**
 * The directory the pull request writes: the frontmatter's name when it is a
 * valid directory name, otherwise `fallback`. Following the file keeps the
 * name check (frontmatter name equals the directory) true while the operator
 * renames the skill in the editor.
 */
export function skillNameOf(text: string, fallback: string): string {
  return skillSourceName(text) ?? fallback;
}

/**
 * The load cost estimate: four characters a token, the estimate the handler
 * holds against the search budget (`estimateSkillTokens`). The real count is
 * the model's tokenizer, and the harness picks the model.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Words for the draft's steps, supplied by the caller's catalog. */
type DraftCopy = {
  purpose: string;
  precondition: string;
  never: string;
  grantsNothing: string;
};

/**
 * The SKILL.md drafted from a description (mockup `wzSkillBody`): the
 * frontmatter the checks require, a title, the description's first sentence
 * as the purpose, and three numbered steps the operator is expected to
 * rewrite. The draft is a template filled in from what the operator wrote,
 * and it is theirs to change line by line.
 */
export function draftSkill(args: {
  desc: string;
  name: string;
  ws: string;
  copy: DraftCopy;
}): string {
  const desc = args.desc.trim();
  const first = /^[\s\S]*?[.!?](?=\s|$)/.exec(desc)?.[0] ?? desc;
  const title = args.name
    .replace(/-/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
  return [
    "---",
    `name: ${args.name}`,
    "version: 0.1.0",
    `scope: workspace:${args.ws}`,
    "---",
    "",
    `# ${title}`,
    "",
    first || args.copy.purpose,
    "",
    `1. ${args.copy.precondition}`,
    `2. ${desc || args.copy.purpose}`,
    `3. ${args.copy.never}`,
    "",
    `> ${args.copy.grantsNothing}`,
    "",
  ].join("\n");
}
