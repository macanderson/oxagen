// scope.ts: which [[autonomy]] scopes a work item falls in, and the level in force.
//
// agent-work-spec.html (Scope): a work item falls in every scope that matches it
// and takes the lowest level among them. A scope not listed is at level 0.
// (Lowering a level): until the steering PR that writes a lowering merges, the
// level in force is the lower of the file and the latest work.autonomy_events
// row. Each rule here fails closed. When a match cannot be decided, the work is
// at level 0.
import { matchesGlob } from "@oxagen/glob";
import { AUTONOMY_LEVELS, type AutonomyEntry, type AutonomyLevel, type AutonomyScope, type WorkFile } from "../types";

/** One work.autonomy_events row, with the fields @oxagen/database selects under these names. */
export interface AutonomyEventRow {
  /** The scope as stored: `{ label }`, or `{ repo, paths }`. */
  scope: unknown;
  toLevel: number;
  createdAt: Date;
}

/** What a scope is matched against: one work item and the change it makes. */
export interface AutonomyTarget {
  /** The work item's labels. */
  labels: readonly string[];
  /** The code repository, as owner/name, when the work touches one. */
  repo?: string;
  /**
   * The paths the change touches: the pull request's files, or the claims triage
   * predicted before one exists. Empty or absent means not known yet.
   */
  paths?: readonly string[];
}

/** One [[autonomy]] entry a target falls in, and its level in force. */
export interface AutonomyMatch {
  entry: AutonomyEntry;
  level: AutonomyLevel;
}

/** The level a target is at, and why. */
export interface AutonomyLevelResult {
  /** The lowest level among the matching scopes. 0 when none matches or one cannot be decided. */
  level: AutonomyLevel;
  matches: AutonomyMatch[];
  /** Path scopes in the target's repository that cannot be decided because its paths are not known. */
  undecided: AutonomyEntry[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The scope in a stored or written value, or null when it is neither
 * `{ label }` nor `{ repo, paths? }` with at least one path.
 */
export function parseAutonomyScope(value: unknown): AutonomyScope | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if ("label" in record) {
    return keys.length === 1 && isNonEmptyString(record.label) ? { label: record.label } : null;
  }
  if (!isNonEmptyString(record.repo) || !keys.every((key) => key === "repo" || key === "paths")) return null;
  if (record.paths === undefined) return { repo: record.repo };
  const paths = record.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every(isNonEmptyString)) return null;
  return { repo: record.repo, paths: [...(paths as string[])] };
}

/**
 * The key that names a scope in policy ids and in `resource.scope`. A repository
 * compares without case, as GitHub does. Paths are sorted and deduplicated, so
 * the same globs in another order name the same scope.
 */
export function scopeKey(scope: AutonomyScope): string {
  if ("label" in scope) return `label:${scope.label}`;
  const repo = `repo:${scope.repo.toLowerCase()}`;
  if (scope.paths === undefined) return repo;
  return `${repo}:${JSON.stringify([...new Set(scope.paths)].sort())}`;
}

/**
 * Whether the target falls in the scope: true, false, or `"undecided"` for a
 * path scope in the target's repository when the target's paths are not known.
 * A path scope matches when any touched path matches any of its globs, so work
 * that reaches into a scope takes that scope's level.
 */
export function scopeMatches(scope: AutonomyScope, target: AutonomyTarget): boolean | "undecided" {
  if ("label" in scope) return target.labels.includes(scope.label);
  if (target.repo === undefined || target.repo.toLowerCase() !== scope.repo.toLowerCase()) return false;
  if (scope.paths === undefined) return true;
  const paths = target.paths ?? [];
  if (paths.length === 0) return "undecided";
  const globs = scope.paths;
  return paths.some((path) => globs.some((glob) => matchesGlob(glob, path)));
}

function toLevel(value: number): AutonomyLevel {
  return (AUTONOMY_LEVELS as readonly number[]).includes(value) ? (value as AutonomyLevel) : 0;
}

/**
 * The level in force: the lower of the file's level and the latest lowering.
 * A lowering whose level is not 0 to 3 counts as 0.
 */
export function levelInForce(fileLevel: AutonomyLevel, latest: Pick<AutonomyEventRow, "toLevel"> | null): AutonomyLevel {
  if (latest === null) return toLevel(fileLevel);
  return Math.min(toLevel(fileLevel), toLevel(latest.toLevel)) as AutonomyLevel;
}

/**
 * The latest event for each scope, by scope key. A row whose scope does not
 * parse names no scope in work.toml, so it cannot lower one.
 */
export function latestEventsByScope(events: readonly AutonomyEventRow[]): Map<string, AutonomyEventRow> {
  const latest = new Map<string, AutonomyEventRow>();
  for (const event of events) {
    const scope = parseAutonomyScope(event.scope);
    if (scope === null) continue;
    const key = scopeKey(scope);
    const current = latest.get(key);
    if (current === undefined || event.createdAt.getTime() > current.createdAt.getTime()) latest.set(key, event);
  }
  return latest;
}

/**
 * The level a target is at: the lowest level in force among the scopes it falls
 * in, or 0 when it falls in none. A path scope that cannot be decided puts the
 * target at 0 until its paths are known.
 */
export function autonomyLevelFor(
  work: Pick<WorkFile, "autonomy">,
  target: AutonomyTarget,
  events: readonly AutonomyEventRow[],
): AutonomyLevelResult {
  const latest = latestEventsByScope(events);
  const matches: AutonomyMatch[] = [];
  const undecided: AutonomyEntry[] = [];
  for (const entry of work.autonomy ?? []) {
    const match = scopeMatches(entry.scope, target);
    if (match === "undecided") undecided.push(entry);
    else if (match) matches.push({ entry, level: levelInForce(entry.level, latest.get(scopeKey(entry.scope)) ?? null) });
  }
  if (undecided.length > 0 || matches.length === 0) return { level: 0, matches, undecided };
  const level = Math.min(...matches.map((m) => m.level)) as AutonomyLevel;
  return { level, matches, undecided };
}
