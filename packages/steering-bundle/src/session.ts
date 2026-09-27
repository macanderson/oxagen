// session.ts: a run's skills reach its harness at session start, outside the
// code repository (steering-repo-spec, Scope and binding).
//
// A code repository holds no committed Oxagen files, because a repository in
// two workspaces cannot hold two sets of skills. So session start writes each
// skill the run receives into the folder where the harness reads user skills,
// and session end removes it. Each folder carries a `.oxagen-session` marker
// that names the version it holds and the sessions using it:
//   - A folder with no marker is a skill someone wrote by hand. It is never
//     touched.
//   - A folder another live session holds at a different version is left as
//     it is, with a warning, so a running session never has its skill changed
//     under it.
//   - The last session to leave deletes the folder.
//
// Where each harness reads user skills:
//   - Claude Code: `$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills`.
//   - Codex: `$CODEX_HOME/skills`, else `~/.agents/skills`.
//   - Stella: `$STELLA_HOME/skills`, else `~/.stella/skills`.
//   - Cursor: none. Cursor reads steering through steering_search and
//     steering_read (see cursor.ts), so session start writes nothing for it.
//
// This module uses Node's file API, so it has its own entry point
// (`@oxagen/steering-bundle/session`) and stays out of the gateway's imports.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Bundle, BundleRecord } from "@oxagen/oxagen/steering-repo/bundle";
import { readSteeringRecord } from "@oxagen/oxagen/steering-repo/record";
import { renderMentions, toolModesOf } from "./mentions";
import { RecordFileError } from "./read";
import type { BundleSource, Delivery } from "./render";
import { compareText } from "./tree";

/** The four first-class harnesses (ADR-101). */
export type Harness = "claude-code" | "codex" | "cursor" | "stella";
export const HARNESSES: readonly Harness[] = ["claude-code", "codex", "cursor", "stella"];

/** The marker file in each folder session start writes. */
export const SESSION_MARKER = ".oxagen-session";

/**
 * How long a session counts as live after it placed a skill. A session that
 * crashed before its end hook ran stops holding the folder after this.
 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** The longest skill name Claude Code and Codex accept. */
export const SKILL_NAME_MAX = 64;

type Env = Readonly<Record<string, string | undefined>>;

function envDir(env: Env, key: string): string | null {
  const value = env[key];
  return value === undefined || value.trim() === "" ? null : value;
}

/** The folder where the harness reads user skills, or null for a harness that reads none. */
export function skillsRoot(
  harness: Harness,
  env: Env = process.env,
  home: string = homedir(),
): string | null {
  switch (harness) {
    case "claude-code":
      return join(envDir(env, "CLAUDE_CONFIG_DIR") ?? join(home, ".claude"), "skills");
    case "codex": {
      const codexHome = envDir(env, "CODEX_HOME");
      return codexHome === null ? join(home, ".agents", "skills") : join(codexHome, "skills");
    }
    case "stella":
      return join(envDir(env, "STELLA_HOME") ?? join(home, ".stella"), "skills");
    case "cursor":
      return null;
  }
}

/**
 * The folder name for a skill: its lineage with dots as hyphens, since Claude
 * Code and Codex take lowercase letters, digits, and hyphens. A name past 64
 * characters keeps its first 55 and ends with 8 characters of the lineage's
 * hash, so two long lineages stay apart.
 *
 * With `digest`, every name ends with the hash. runSkills asks for it when two
 * of a run's lineages differ only in a dot and a hyphen, such as
 * `a-intel.brand.voice` and `a-intel.brand-voice`, which would share a folder.
 */
export function skillFolderName(lineage: string, options: { digest?: boolean } = {}): string {
  const name = lineage.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (options.digest !== true && name.length <= SKILL_NAME_MAX) return name;
  const digest = createHash("sha256").update(lineage).digest("hex").slice(0, 8);
  return `${name.slice(0, SKILL_NAME_MAX - 9).replace(/-+$/, "")}-${digest}`;
}

/** Give each skill that shares its folder name with another the name that ends with its lineage's hash. */
function separateNames(skills: SessionSkill[]): void {
  const counts = new Map<string, number>();
  for (const skill of skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  for (const skill of skills) {
    if ((counts.get(skill.name) ?? 0) > 1) {
      skill.name = skillFolderName(skill.lineage, { digest: true });
    }
  }
}

/** One file of a skill, by its path inside the skill's folder. */
export interface SkillFile {
  path: string;
  content: string | Uint8Array;
}

/** A skill as session start writes it. */
export interface SessionSkill {
  lineage: string;
  /** The folder name, which is also the skill's `name`. */
  name: string;
  description: string;
  /** SKILL.md's body, with the frontmatter removed and @tool: mentions rendered. */
  body: string;
  files: SkillFile[];
  source: BundleSource;
  version: number;
}

/** Reads one file of a published version by its blob. A skill asset may be binary. */
export type ReadAsset = (
  source: BundleSource,
  bundle: Bundle,
  file: { path: string; blob: string },
) => Promise<string | Uint8Array>;

function textOf(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

/**
 * The skills a run on `repository` receives: every skill in the workspace's
 * and the organization's published versions whose `repos` is unset or names
 * the repository. A workspace skill wins over an organization skill of the
 * same lineage.
 */
export async function runSkills(
  delivery: Delivery,
  repository: string | null,
  readAsset: ReadAsset,
): Promise<SessionSkill[]> {
  const chosen = new Map<string, { record: BundleRecord; source: BundleSource; bundle: Bundle }>();
  const sources: BundleSource[] = ["organization", "workspace"];
  for (const source of sources) {
    const bundle = delivery[source];
    if (bundle === null) continue;
    for (const record of bundle.records) {
      if (record.kind !== "skill") continue;
      if (
        record.repos !== undefined &&
        (repository === null || !record.repos.includes(repository))
      ) {
        continue;
      }
      chosen.set(record.lineage, { record, source, bundle });
    }
  }
  const skills: SessionSkill[] = [];
  for (const { record, source, bundle } of chosen.values()) {
    const read = readSteeringRecord(
      textOf(await readAsset(source, bundle, { path: record.path, blob: record.blob })),
    );
    if (!read.ok) throw new RecordFileError(record.path);
    const folder = record.path.slice(0, record.path.lastIndexOf("/") + 1);
    const files: SkillFile[] = [];
    for (const file of record.files ?? []) {
      if (!file.path.startsWith(folder)) continue;
      files.push({
        path: file.path.slice(folder.length),
        content: await readAsset(source, bundle, file),
      });
    }
    files.sort((a, b) => compareText(a.path, b.path));
    skills.push({
      lineage: record.lineage,
      name: skillFolderName(record.lineage),
      description: record.description ?? record.label,
      body: renderMentions(read.body, toolModesOf(bundle)),
      files,
      source,
      version: bundle.version,
    });
  }
  separateNames(skills);
  return skills.sort((a, b) => compareText(a.name, b.name));
}

/** SKILL.md as the harness reads it: `name` and `description`, then the body. */
export function skillMarkdown(skill: Pick<SessionSkill, "name" | "description" | "body">): string {
  // A JSON string is a valid YAML double-quoted scalar, so any description parses.
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body.replace(/^\n+/, "")}`;
}

/** A digest over everything session start writes for the skill. */
export function skillDigest(skill: SessionSkill): string {
  const hash = createHash("sha256");
  hash.update(skillMarkdown(skill));
  for (const file of skill.files) {
    hash.update("\0");
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
  }
  return `sha256:${hash.digest("hex")}`;
}

interface Marker {
  digest: string;
  /** Each session using the folder, with when it placed the skill. */
  sessions: Record<string, string>;
}

function isMarker(value: unknown): value is Marker {
  if (typeof value !== "object" || value === null) return false;
  const { digest, sessions } = value as { digest?: unknown; sessions?: unknown };
  return (
    typeof digest === "string" &&
    typeof sessions === "object" &&
    sessions !== null &&
    Object.values(sessions).every((at) => typeof at === "string")
  );
}

type MarkerRead = { state: "absent" } | { state: "foreign" } | { state: "ours"; marker: Marker };

async function readMarker(folder: string): Promise<MarkerRead> {
  let entries: string[];
  try {
    entries = await readdir(folder);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "absent" };
    // A file where a skill folder would go is not ours to replace.
    if (code === "ENOTDIR") return { state: "foreign" };
    throw error;
  }
  if (!entries.includes(SESSION_MARKER)) return { state: "foreign" };
  try {
    const parsed = JSON.parse(await readFile(join(folder, SESSION_MARKER), "utf8")) as unknown;
    return isMarker(parsed) ? { state: "ours", marker: parsed } : { state: "foreign" };
  } catch {
    // A marker that does not parse was not written by this module.
    return { state: "foreign" };
  }
}

function liveSessions(marker: Marker, now: Date): Record<string, string> {
  const live: Record<string, string> = {};
  for (const [session, at] of Object.entries(marker.sessions)) {
    const placed = Date.parse(at);
    if (Number.isFinite(placed) && now.getTime() - placed < SESSION_TTL_MS) live[session] = at;
  }
  return live;
}

async function writeMarker(folder: string, marker: Marker): Promise<void> {
  await writeFile(join(folder, SESSION_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
}

async function writeSkill(folder: string, skill: SessionSkill): Promise<void> {
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "SKILL.md"), skillMarkdown(skill));
  for (const file of skill.files) {
    const target = join(folder, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

export interface PlaceResult {
  /** Skills written or joined, by folder name. */
  placed: string[];
  /** Skills left out, by folder name. */
  skipped: string[];
  warnings: string[];
}

/** Write the run's skills under `root` for the session. */
export async function placeSkills(
  root: string,
  sessionId: string,
  skills: readonly SessionSkill[],
  now: Date = new Date(),
): Promise<PlaceResult> {
  const result: PlaceResult = { placed: [], skipped: [], warnings: [] };
  await mkdir(root, { recursive: true });
  const taken = new Set<string>();
  for (const skill of skills) {
    const folder = join(root, skill.name);
    // A second skill with the same folder name would replace the first.
    if (taken.has(skill.name)) {
      result.skipped.push(skill.name);
      result.warnings.push(
        `${skill.lineage} was not placed, because another skill of this session already uses ${folder}.`,
      );
      continue;
    }
    taken.add(skill.name);
    const digest = skillDigest(skill);
    const found = await readMarker(folder);
    if (found.state === "foreign") {
      result.skipped.push(skill.name);
      result.warnings.push(
        `${folder} holds a skill Oxagen did not write, so ${skill.lineage} was not placed. Rename that folder to receive it.`,
      );
      continue;
    }
    const others =
      found.state === "ours"
        ? Object.keys(liveSessions(found.marker, now)).filter((session) => session !== sessionId)
        : [];
    if (found.state === "ours" && found.marker.digest === digest) {
      const sessions = { ...liveSessions(found.marker, now), [sessionId]: now.toISOString() };
      await writeMarker(folder, { digest, sessions });
      result.placed.push(skill.name);
      continue;
    }
    if (others.length > 0) {
      result.skipped.push(skill.name);
      result.warnings.push(
        `${skill.lineage} kept the version another running session placed in ${folder}. This session reads that version until it ends.`,
      );
      continue;
    }
    await writeSkill(folder, skill);
    await writeMarker(folder, { digest, sessions: { [sessionId]: now.toISOString() } });
    result.placed.push(skill.name);
  }
  return result;
}

export interface RemoveResult {
  /** Folders deleted, because no live session holds them. */
  removed: string[];
  /** Folders another live session still holds. */
  kept: string[];
}

/**
 * Remove the session from every folder it placed under `root`. A folder no
 * live session holds is deleted, which also clears folders a crashed session
 * left behind.
 */
export async function removeSkills(
  root: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<RemoveResult> {
  const result: RemoveResult = { removed: [], kept: [] };
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const name of names.sort(compareText)) {
    const folder = join(root, name);
    const found = await readMarker(folder);
    if (found.state !== "ours") continue;
    const sessions = liveSessions(found.marker, now);
    const held = sessionId in found.marker.sessions;
    delete sessions[sessionId];
    if (Object.keys(sessions).length === 0) {
      await rm(folder, { recursive: true, force: true });
      result.removed.push(name);
    } else if (held) {
      await writeMarker(folder, { digest: found.marker.digest, sessions });
      result.kept.push(name);
    }
  }
  return result;
}
