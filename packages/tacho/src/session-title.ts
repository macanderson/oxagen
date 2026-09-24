/**
 * A name for a run that exists from its first frame.
 *
 * `summarize_run` writes a model-authored name and summary, and it is the
 * better read when it is there. It cannot be the only one: it refuses a run
 * that is still live (`run_not_sealed`) and refuses a workspace recording
 * `digest_only`, so the runs an operator is watching right now are exactly
 * the ones it never names, and a uuid is what the list shows instead.
 *
 * This is the floor under that. It is derived from facts every tier records,
 * never from prompt text, so it works the same whether the workspace retains
 * content or not, and it sharpens as the run goes rather than arriving at the
 * end. It states what the record shows and nothing else: where the work
 * happened, on which branch, and how much of it there is. It never names an
 * outcome, because a run in flight has none.
 *
 * Order is deliberate. The place comes first because that is what tells two
 * runs apart in a list, the branch second because that is what tells two runs
 * in the same place apart, and the size last because it is the part that
 * changes while you watch. It reads as a phrase, `oxagen on agent/volta
 * (3 files)`, since a label joined with separators is hard to scan.
 */

/** What the session row and its rollups know, at any point in a run. */
export interface SessionTitleFacts {
  /** `CLAUDE_PROJECT_DIR`, the project the agent was pointed at. */
  projectDir?: string | null;
  /** Where the agent was working, when no project dir was reported. */
  cwd?: string | null;
  /** The worktree, when the run happened in one. */
  worktreePath?: string | null;
  gitBranch?: string | null;
  /** Distinct paths the run wrote or edited. */
  filesChanged?: number;
  /** Shell commands the run ran. */
  commandsRun?: number;
}

/** Branches that say nothing about which run this is. */
const UNREMARKABLE_BRANCHES = new Set(["main", "master", "HEAD", ""]);

/** The most a derived title may run to, so a list stays readable. */
const TITLE_MAX = 80;

/** A segment with a letter or a digit in it says which folder it is. */
const NAMES_A_PLACE = /[\p{L}\p{N}]/u;

/**
 * The last segment of a path, with any trailing separator ignored.
 *
 * A segment with no letter or digit, such as `_` or `--`, names nothing on
 * its own, so it keeps its parents up to the nearest one that does:
 * `~/Documents/_` reads `Documents/_`.
 */
function basename(path: string): string | undefined {
  const segments = path.split(/[/\\]+/).filter((segment) => segment !== "");
  const name = segments.pop();
  if (name === undefined) return undefined;
  const kept = [name];
  while (!NAMES_A_PLACE.test(kept[0] ?? "") && segments.length > 0)
    kept.unshift(segments.pop() ?? "");
  return kept.join("/");
}

function countPart(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * `text` cut to `max` units with an ellipsis, never between the two halves of
 * a surrogate pair, which would leave a character that is not Unicode.
 */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * A name for this run, or undefined when the record says nothing worth
 * naming it by. Undefined is the honest answer for a session that has
 * reported no place and done no work: a caller that invents one anyway is
 * writing fiction into a column people read.
 */
export function deriveSessionTitle(
  facts: SessionTitleFacts,
): string | undefined {
  const place =
    basename(facts.worktreePath ?? "") ??
    basename(facts.projectDir ?? "") ??
    basename(facts.cwd ?? "");

  const trimmed = facts.gitBranch?.trim();
  const branch =
    trimmed !== undefined && !UNREMARKABLE_BRANCHES.has(trimmed)
      ? trimmed
      : undefined;

  const where =
    place !== undefined && branch !== undefined
      ? `${place} on ${branch}`
      : (place ?? branch);

  const changed = facts.filesChanged ?? 0;
  const commands = facts.commandsRun ?? 0;
  const size =
    changed > 0
      ? countPart(changed, "file", "files")
      : commands > 0
        ? countPart(commands, "command", "commands")
        : undefined;

  if (where === undefined) return size;
  if (size === undefined) return shorten(where, TITLE_MAX);
  // A long place or branch gives way, so the size is always read whole.
  const suffix = ` (${size})`;
  return `${shorten(where, TITLE_MAX - suffix.length)}${suffix}`;
}
