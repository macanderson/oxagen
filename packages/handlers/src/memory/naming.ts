// What the curator names a memory record: its lineage, label, description,
// and path in the steering repo (ADR-206, decision 6).
import {
  steeringRecordSlug,
  fitSteeringRecordLabel,
} from "@oxagen/oxagen/steering-record-label";
import { DESCRIPTION_MAX } from "@oxagen/oxagen/steering-repo/tokens";
import { MEMORY_DIR, recordFileName } from "@oxagen/oxagen/steering-repo/paths";
import { TOOL_SEPARATOR } from "@oxagen/oxagen/steering-repo/names";
import { normalizeStatement } from "./statement";

/** The longest lineage the curator mints, so a path stays readable. */
export const MEMORY_LINEAGE_MAX = 64;

/** The folder for a memory with no repository. */
export const WORKSPACE_FOLDER = "workspace";

/** The area for a memory that names no path and no tool. */
export const GENERAL_AREA = "general";

/** Words a lineage leaves out, so it names the lesson and not its grammar. */
const LINEAGE_SKIP: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "to",
  "in",
  "on",
  "for",
  "is",
  "are",
  "be",
  "it",
  "its",
  "this",
  "that",
  "with",
  "when",
]);

/** Cut a slug at its last hyphen that keeps it within `max`, and trim what a lineage cannot end on. */
function fitSlug(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max + 1);
  const hyphen = cut.lastIndexOf("-");
  const fitted = hyphen > 0 ? cut.slice(0, hyphen) : slug.slice(0, max);
  return fitted.replace(/[.-]+$/g, "");
}

/**
 * A lineage for a new memory record: the statement's words as a slug, at
 * most 64 characters, and not one `taken` already holds. A clash takes the
 * first free `-2`, `-3`, and so on.
 */
export function memoryLineage(
  statement: string,
  taken: ReadonlySet<string>,
): string {
  const words = normalizeStatement(statement)
    .split(" ")
    .filter((word) => word !== "" && !LINEAGE_SKIP.has(word));
  const base =
    fitSlug(steeringRecordSlug(words.join(" ")), MEMORY_LINEAGE_MAX) ||
    "memory";
  const lineage = base.length >= 2 ? base : `memory-${base}`;
  if (!taken.has(lineage)) return lineage;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${fitSlug(lineage, MEMORY_LINEAGE_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The statement's first sentence, or the whole statement when it has none. */
function firstSentence(statement: string): string {
  const tidy = statement.trim().replace(/\s+/g, " ");
  const end = tidy.search(/[.!?](\s|$)/);
  return end > 0 ? tidy.slice(0, end) : tidy;
}

/** A label of at most 36 characters, cut from the statement's first sentence. */
export function memoryLabel(statement: string): string {
  const label = fitSteeringRecordLabel(firstSentence(statement)).replace(
    /[\s,;:.-]+$/,
    "",
  );
  return label === "" ? "Memory" : label;
}

/** A description of at most 200 characters: the statement, cut at a word when it is longer. */
export function memoryDescription(statement: string): string {
  const tidy = statement.trim().replace(/\s+/g, " ");
  if (tidy.length <= DESCRIPTION_MAX) return tidy;
  const cut = tidy.slice(0, DESCRIPTION_MAX - 2);
  const space = cut.lastIndexOf(" ");
  const kept = (space > 0 ? cut.slice(0, space) : cut).replace(
    /[\s,;:.-]+$/,
    "",
  );
  return `${kept}...`;
}

/** A folder name from free text, or null when nothing file-safe is left. */
function folderSlug(value: string): string | null {
  const slug = steeringRecordSlug(value.replace(/[._]+/g, "-"));
  return slug === "" ? null : slug;
}

/** Does a path segment hold a glob character? */
function isGlob(segment: string): boolean {
  return /[*?[\]{}!]/.test(segment);
}

/**
 * The area a memory belongs to: the deepest fixed folder of its first
 * `applies_to` glob, else the server of its first tool, else `general`.
 * `src/billing/**` is `billing`, and `billing__create_refund` is `billing`.
 */
export function memoryArea(
  appliesTo: readonly string[] | null,
  tools: readonly string[] | null,
): string {
  const glob = appliesTo?.[0];
  if (glob !== undefined) {
    const segments = glob.split("/").filter((s) => s !== "" && s !== ".");
    const fixed: string[] = [];
    for (const [i, segment] of segments.entries()) {
      if (isGlob(segment)) break;
      // The last segment of a glob with no wildcard is a file, not a folder.
      if (i === segments.length - 1 && segment.includes(".")) break;
      fixed.push(segment);
    }
    const folder = fixed.length > 0 ? folderSlug(fixed.at(-1) as string) : null;
    if (folder !== null) return folder;
  }
  const tool = tools?.[0];
  if (tool !== undefined) {
    const server = tool.split(TOOL_SEPARATOR, 1)[0] ?? "";
    const folder = folderSlug(server);
    if (folder !== null) return folder;
  }
  return GENERAL_AREA;
}

/**
 * Where a new memory record lives:
 * `steering/memory/<repository or workspace>/<area>/<lineage>.md`. A
 * repository reference `github.com/acme/api` becomes three folders.
 */
export function memoryRecordPath(
  repos: readonly string[] | null,
  appliesTo: readonly string[] | null,
  tools: readonly string[] | null,
  lineage: string,
): string {
  const repo = repos?.[0];
  const shard = repo === undefined ? WORKSPACE_FOLDER : repo;
  return `${MEMORY_DIR}/${shard}/${memoryArea(appliesTo, tools)}/${recordFileName(lineage)}`;
}

/** The shard a memory is grouped in: its first repository, or the workspace. */
export function memoryShard(repos: readonly string[] | null): string {
  return repos?.[0] ?? WORKSPACE_FOLDER;
}
