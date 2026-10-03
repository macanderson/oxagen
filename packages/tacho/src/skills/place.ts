// place.ts: session start writes a run's skills where its harness reads user
// skills, and session end removes them (steering-repo-spec, Scope and
// binding).
//
// A code repository holds no committed Oxagen files, because a repository in
// two workspaces cannot hold two sets of skills. So session start writes each
// skill the run receives into the folder where the harness reads user skills,
// and session end removes it. Each folder carries a `.oxagen-session` marker
// that names the version it holds and the sessions using it:
//   - A folder with no marker is a skill someone wrote by hand. It is never
//     touched.
//   - A folder another live session holds at a different version is left as
//     it is, with a warning. The session that asked for the other version
//     joins the marker, so the folder stays until every session reading it
//     ends, and a running session never has its skill changed under it.
//   - The last session to leave deletes the folder.
//
// Each call reads a marker and then writes it, with no lock. The caller runs
// one call at a time under a root (`sessionSkills` in the collector does),
// or two sessions' calls can delete a folder one of them just joined.
//
// Where each harness reads user skills:
//   - Claude Code: `$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills`.
//   - Codex: `$CODEX_HOME/skills`, else `~/.agents/skills`.
//   - Stella: `$STELLA_HOME/skills`, else `~/.stella/skills`.
//   - Cursor: none. Cursor reads steering through search_steering and
//     read_steering, so session start writes nothing for it.
//   - Claude Desktop: none. It is connected, not wrapped (ADR-078), and runs
//     no session hooks.
//
// The server chooses the skills (`runSkills` in @oxagen/steering-bundle) and
// sends them in the policy bundle. This module lives in tacho because the
// collector is what writes them, on the machine the harness runs on.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TachoHarness } from "../wire";

/** The marker file in each folder session start writes. */
export const SESSION_MARKER = ".oxagen-session";

/**
 * How long a session counts as live after it placed a skill. A session that
 * crashed before its end hook ran stops holding the folder after this.
 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** The longest skill name Claude Code and Codex accept. */
export const SKILL_NAME_MAX = 64;

/**
 * A skill's folder name: lowercase letters, digits, and hyphens, as Claude
 * Code and Codex require. A name of this shape can never climb out of the
 * skills folder, since it holds no dot and no slash.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

/** Where a skill came from: the workspace's published version or the organization's. */
export type SkillSource = "organization" | "workspace";

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
  source: SkillSource;
  version: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function envDir(env: Env, key: string): string | null {
  const value = env[key];
  return value === undefined || value.trim() === "" ? null : value;
}

/** The folder where the harness reads user skills, or null for a harness that reads none. */
export function skillsRoot(
  harness: TachoHarness,
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
    case "claude-desktop":
      return null;
  }
}

/**
 * Why a file path inside a skill's folder is refused, or null when it is safe
 * to write. A path is relative, uses `/`, and names no `.` or `..` segment,
 * so it cannot land outside the folder. `SKILL.md` and the marker at the top
 * of the folder belong to this module.
 */
export function skillFileRefusal(path: string): string | null {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return "is not a relative path";
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "is not a relative path";
  }
  if (path === "SKILL.md" || path === SESSION_MARKER) return "is a file session start writes";
  return null;
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
  /** Each session using the folder, with when it joined. */
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

/** Why a skill cannot be written at all, or null when it can. */
function skillRefusal(skill: SessionSkill): string | null {
  if (!SKILL_NAME_PATTERN.test(skill.name)) {
    return `${skill.lineage} was not placed, because its folder name ${JSON.stringify(skill.name)} is not a skill name.`;
  }
  for (const file of skill.files) {
    const refusal = skillFileRefusal(file.path);
    if (refusal !== null) {
      return `${skill.lineage} was not placed, because its file ${JSON.stringify(file.path)} ${refusal}.`;
    }
  }
  return null;
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
    const refusal = skillRefusal(skill);
    if (refusal !== null) {
      result.skipped.push(skill.name);
      result.warnings.push(refusal);
      continue;
    }
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
    if (found.state === "absent") {
      await writeSkill(folder, skill);
      await writeMarker(folder, { digest, sessions: { [sessionId]: now.toISOString() } });
      result.placed.push(skill.name);
      continue;
    }
    const live = liveSessions(found.marker, now);
    const joined = { ...live, [sessionId]: now.toISOString() };
    if (found.marker.digest === digest) {
      await writeMarker(folder, { digest, sessions: joined });
      result.placed.push(skill.name);
      continue;
    }
    if (Object.keys(live).some((session) => session !== sessionId)) {
      // This session reads the version already there until it ends, so it
      // holds the folder too. Without joining, the placing session's end
      // would delete the folder under it.
      await writeMarker(folder, { digest: found.marker.digest, sessions: joined });
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

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Remove the session from every folder it placed or joined under `root`. A
 * folder no live session holds is deleted, which also clears folders a
 * crashed session left behind.
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
