// repository.workspace-toml.ts: the linked repositories workspace.toml lists
// (ADR-212). The steering record decides which code repositories a workspace
// links. workspace.toml on the steering repository lists each one as a
// `[[repositories]]` entry, the steering PRs from `link_repository` and
// `unlink_repository` edit that list, and the steering sync reads it.
//
// The handlers and the sync read the file the same way, through
// `readWorkspaceToml`, so they never disagree about what it lists:
//   - missing: nothing is listed.
//   - foreign: the first line does not name workspace/v1. Another tool owns
//     the file, and it lists nothing.
//   - unreadable: the first line names workspace/v1, but the file does not
//     read against the schema. Nobody can tell what it lists.
//   - read: the schema holds, and `repositories` is the list.
//
// An edit changes the text the least it can, so a person's comments and
// layout survive the steering PR. Every edit is checked by reading it back:
// the result must read as workspace/v1, list exactly the expected
// repositories, and hold every other value unchanged. When the small edit
// fails that check, the file is written again from its parsed value.
import { isDeepStrictEqual } from "node:util";
import {
  type FileIssue,
  readTomlFile,
} from "@oxagen/oxagen/steering-repo/files";
import { repoRef } from "@oxagen/oxagen/steering-repo/names";
import { schemaDirective } from "@oxagen/oxagen/steering-repo/schema-ids";
import { workspaceTomlTemplate } from "@oxagen/oxagen/steering-repo/templates";
import {
  type WorkspaceFile,
  workspaceSchema,
} from "@oxagen/oxagen/steering-repo/workspace";
import { parse, stringify } from "smol-toml";

/** The host every repository `link_repository` writes is on. */
export const GITHUB_HOST = "github.com";

/** workspace.toml, read the way the handlers and the sync both read it. */
export type WorkspaceToml =
  | { kind: "missing" }
  | { kind: "foreign" }
  | { kind: "unreadable"; issues: FileIssue[] }
  | {
      kind: "read";
      text: string;
      value: WorkspaceFile;
      /** Every `[[repositories]]` url, in file order. */
      repositories: string[];
    };

/** The file at one ref, or null when the ref has no such file. */
export function readWorkspaceToml(text: string | null): WorkspaceToml {
  if (text === null) return { kind: "missing" };
  // A byte-order mark or a CRLF ending does not hide a workspace/v1 file.
  // The reader below reports either one.
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  if (firstLine !== schemaDirective("workspace/v1")) return { kind: "foreign" };
  const read = readTomlFile(text, "workspace/v1", workspaceSchema);
  if (!read.ok) return { kind: "unreadable", issues: read.issues };
  return {
    kind: "read",
    text,
    value: read.value,
    repositories: (read.value.repositories ?? []).map((r) => r.url),
  };
}

/** What a file lists, or null when nobody can tell. */
export function listedRepositories(file: WorkspaceToml): string[] | null {
  switch (file.kind) {
    case "missing":
    case "foreign":
      return [];
    case "unreadable":
      return null;
    case "read":
      return file.repositories;
  }
}

/** `github.com/<owner>/<name>`, lowercase, the way workspace.toml lists a GitHub repository. */
export function githubRepoRef(owner: string, name: string): string {
  return repoRef(GITHUB_HOST, owner, name);
}

/**
 * A listed repository's host, owner, and name. The owner may hold slashes, for
 * a GitLab subgroup, so the name is the last segment.
 */
export function splitRepoRef(ref: string): {
  host: string;
  owner: string;
  name: string;
} {
  const parts = ref.split("/");
  return {
    host: parts[0] ?? "",
    owner: parts.slice(1, -1).join("/"),
    name: parts[parts.length - 1] ?? "",
  };
}

/** A new workspace.toml that lists one repository. */
export function newWorkspaceToml(
  organization: string,
  workspace: string,
  ref: string,
): string {
  const text = `${workspaceTomlTemplate(organization, workspace)}\n[[repositories]]\nurl = ${JSON.stringify(ref)}\n`;
  const read = readWorkspaceToml(text);
  if (read.kind !== "read" || !isDeepStrictEqual(read.repositories, [ref]))
    throw new Error(
      `[repository.workspace-toml] a new workspace.toml for ${organization}/${workspace} does not read as workspace/v1`,
    );
  return text;
}

/** `file` with `ref` added as the last `[[repositories]]` entry. */
export function withRepository(
  file: Extract<WorkspaceToml, { kind: "read" }>,
  ref: string,
): string {
  const appended = `${file.text}\n[[repositories]]\nurl = ${JSON.stringify(ref)}\n`;
  return checked(file, appended, [...file.repositories, ref]);
}

/** `file` without the `[[repositories]]` entry for `ref`. */
export function withoutRepository(
  file: Extract<WorkspaceToml, { kind: "read" }>,
  ref: string,
): string {
  const lines = file.text.split("\n");
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!ARRAY_HEADER.test(line)) {
      kept.push(line);
      i += 1;
      continue;
    }
    // The entry runs to the next table header. Blank lines and comments at
    // its end stay: a comment there most likely introduces the next table.
    let end = i + 1;
    while (end < lines.length && !TABLE_HEADER.test(lines[end] as string))
      end += 1;
    let last = i;
    for (let j = i + 1; j < end; j += 1) {
      const trimmed = (lines[j] as string).trim();
      if (trimmed !== "" && !trimmed.startsWith("#")) last = j;
    }
    const entry = lines.slice(i, last + 1);
    if (!entry.some((l) => urlOf(l) === ref)) {
      kept.push(...entry);
      i = last + 1;
      continue;
    }
    // One blank line went with the entry when it was added.
    const next = lines[last + 1];
    if (
      kept.length > 0 &&
      (kept[kept.length - 1] as string).trim() === "" &&
      (next === undefined || next.trim() === "")
    )
      kept.pop();
    i = last + 1;
  }
  const text = kept.join("\n");
  return checked(
    file,
    text.endsWith("\n") ? text : `${text}\n`,
    file.repositories.filter((r) => r !== ref),
  );
}

const ARRAY_HEADER = /^\s*\[\[\s*repositories\s*\]\]\s*(?:#.*)?$/;
const TABLE_HEADER = /^\s*\[/;
const URL_LINE = /^\s*url\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/;

/** The url a `url = "..."` line names, or null for any other line. */
function urlOf(line: string): string | null {
  const m = URL_LINE.exec(line);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * `candidate` when it reads as workspace/v1, lists `expected`, and keeps
 * every other value of `file`. Otherwise the file written again from its
 * parsed value, which loses its comments but always says the right thing.
 */
function checked(
  file: Extract<WorkspaceToml, { kind: "read" }>,
  candidate: string,
  expected: string[],
): string {
  if (keepsTheRest(file.text, candidate, expected)) return candidate;
  const { repositories: _dropped, ...rest } = parse(file.text) as Record<
    string,
    unknown
  >;
  const body = stringify(
    expected.length > 0
      ? { ...rest, repositories: expected.map((url) => ({ url })) }
      : rest,
  );
  const rewritten = `${schemaDirective("workspace/v1")}\n${body.endsWith("\n") ? body : `${body}\n`}`;
  if (keepsTheRest(file.text, rewritten, expected)) return rewritten;
  throw new Error(
    "[repository.workspace-toml] an edit to workspace.toml did not read back as the list it was meant to hold",
  );
}

function keepsTheRest(
  before: string,
  after: string,
  expected: string[],
): boolean {
  const read = readWorkspaceToml(after);
  if (read.kind !== "read" || !isDeepStrictEqual(read.repositories, expected))
    return false;
  const { repositories: _a, ...was } = parse(before) as Record<string, unknown>;
  const { repositories: _b, ...now } = parse(after) as Record<string, unknown>;
  return isDeepStrictEqual(was, now);
}
