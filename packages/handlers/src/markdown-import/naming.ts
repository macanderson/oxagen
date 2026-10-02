// markdown-import/naming.ts: the names the Markdown import gives what it
// writes (discussions spec, Markdown import: Records). A lineage comes from
// the organization, the file's folders and name, and the statement's label,
// such as a-intel.docs.release-checklist.tag-the-release. A label fits the
// 36-character cap, and a description is the statement's first sentence.
import {
  STEERING_RECORD_LINEAGE,
  fitSteeringRecordLabel,
} from "@oxagen/oxagen/steering-record-label";
import { DESCRIPTION_MAX } from "@oxagen/oxagen/steering-repo/tokens";

/** The longest lineage the import writes, so a file name stays well inside a host's 255-byte limit. */
const LINEAGE_MAX = 120;
/** The longest slug one part of a lineage takes. */
const PART_MAX = 48;

/** Lowercase letters, digits, and single hyphens, or "" when nothing is left. */
export function slugPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PART_MAX)
    .replace(/-+$/g, "");
}

/** The file's folders and name without its extension, each as a slug: `docs/Release Checklist.md` is [docs, release-checklist]. */
export function fileParts(filename: string): string[] {
  const segments = filename.replace(/\\/g, "/").split("/");
  const last = segments.pop() ?? "";
  const stem = last.replace(/\.(md|mdc|markdown|mdx|txt)$/i, "");
  return [...segments, stem]
    .map(slugPart)
    .filter((part) => part !== "" && part !== "." && part !== "..");
}

/** The slug a policy file takes from its Markdown file's name: `No branch delete.md` is no-branch-delete. */
export function policySlug(filename: string): string {
  const parts = fileParts(filename);
  return parts[parts.length - 1] || "policy";
}

/** True for a README or index file, which the import skips by default. */
export function isIndexFile(filename: string): boolean {
  const name = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  return /^(readme|index)\.(md|mdx|markdown)$/i.test(name);
}

/**
 * A lineage from its parts, cut to LINEAGE_MAX at a part boundary. Falls back
 * to `<first part>.imported` when nothing valid is left.
 */
export function lineageOf(parts: readonly string[]): string {
  const kept = parts.map(slugPart).filter((part) => part !== "");
  let lineage = "";
  for (const part of kept) {
    const next = lineage === "" ? part : `${lineage}.${part}`;
    if (next.length > LINEAGE_MAX) break;
    lineage = next;
  }
  if (STEERING_RECORD_LINEAGE.test(lineage) && lineage.includes(".")) return lineage;
  return `${kept[0] || "import"}.imported`;
}

/**
 * The first lineage from `base` that `taken` does not hold: `base`, then
 * `base-2`, `base-3`, and so on. Adds the answer to `taken`.
 */
export function uniqueLineage(base: string, taken: Set<string>): string {
  let lineage = base;
  for (let n = 2; taken.has(lineage); n += 1) lineage = `${base}-${n}`;
  taken.add(lineage);
  return lineage;
}

/** A label from a proposed name or, failing that, the statement's first words. */
export function labelOf(proposed: string | null, statement: string): string {
  const fitted = fitSteeringRecordLabel(proposed ?? "");
  if (fitted !== "") return fitted;
  const words = statement.replace(/[#*_`>]+/g, " ").trim();
  return fitSteeringRecordLabel(words) || "Imported record";
}

/** The statement's first sentence, at most `max` characters, cut at a word. */
export function firstSentence(statement: string, max = DESCRIPTION_MAX): string {
  const line = statement.replace(/\s+/g, " ").trim();
  const match = /^(.+?[.!?])(\s|$)/.exec(line);
  const sentence = (match?.[1] ?? line).trim();
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut.slice(0, max)).trimEnd();
}

