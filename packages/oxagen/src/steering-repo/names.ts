// names.ts: the names the Shared contract fixes, and the helpers that build
// and read them (steering-repo-spec, Shared contract).
import { CONTEXT_RECORD_LINEAGE } from "../context-record-label";
import { WORKSPACE_SLUG_PATTERN } from "../workspace-slug";

// ── Repository, check, and environment ──────────────────────────────────────

/** The one required check on a steering repo's `main`. */
export const REQUIRED_CHECK_NAME = "Oxagen steering";
/** The check Oxagen posts on a linked code repository's pull requests. */
export const CODE_REPOSITORY_CHECK_NAME = "Oxagen";
/** The environment each publish records a deployment to. */
export const STEERING_ENVIRONMENT = "steering";
/** The branch Oxagen publishes from. */
export const STEERING_DEFAULT_BRANCH = "main";
/** The organization's repository for `scope: organization` records: `<org>/oxagen`. */
export const ORGANIZATION_REPO_NAME = "oxagen";
/** Every steering repo name starts with this. */
export const STEERING_REPO_NAME_PREFIX = "oxagen-";

/**
 * The name of a workspace's steering repo: `oxagen-<slug>`, then
 * `oxagen-<slug>-2`, `-3`, and so on when the name is taken.
 */
export function steeringRepoName(workspaceSlug: string, n = 1): string {
  if (!WORKSPACE_SLUG_PATTERN.test(workspaceSlug)) {
    throw new RangeError(
      `"${workspaceSlug}" is not a workspace slug. Use lowercase letters and digits, separated by single hyphens.`,
    );
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`the attempt number is a whole number from 1, not ${n}`);
  }
  const base = `${STEERING_REPO_NAME_PREFIX}${workspaceSlug}`;
  return n === 1 ? base : `${base}-${n}`;
}

// ── Branches ─────────────────────────────────────────────────────────────────

/**
 * A steering PR's branch starts with the top-level folder it changes, with
 * two exceptions: a change to workspace.toml uses `workspace/`, and a memory
 * PR, which changes steering/memory/, uses `memory/`.
 */
export const BRANCH_PREFIXES = [
  "steering",
  "memory",
  "tools",
  "agents",
  "policy",
  "workspace",
] as const;
export type BranchPrefix = (typeof BRANCH_PREFIXES)[number];

/** The prefix a steering PR's branch starts with, or null when it has none. */
export function branchPrefixOf(branch: string): BranchPrefix | null {
  for (const prefix of BRANCH_PREFIXES) {
    if (branch.startsWith(`${prefix}/`) && branch.length > prefix.length + 1) {
      return prefix;
    }
  }
  return null;
}

// ── Tool names ───────────────────────────────────────────────────────────────

/** Joins a server name and a tool key. */
export const TOOL_SEPARATOR = "__";
/** The server name built-in tools use. No MCP server may take it. */
export const BUILTIN_SERVER = "builtin";
/** Model APIs refuse a longer tool name. */
export const TOOL_NAME_MAX = 64;
/** A server name: the folder under tools/servers/. */
export const SERVER_NAME_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;
/** A tool's key in its server's tools.toml. */
export const TOOL_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
/** `<server>__<tool>`, 64 characters at most. */
export const TOOL_NAME_PATTERN =
  /^(?=[a-z0-9_]{4,64}$)[a-z][a-z0-9_]{0,23}__[a-z][a-z0-9_]*$/;
/** A tool name, or `<server>__*` for every imported tool of one server. */
export const TOOL_TARGET_PATTERN =
  /^(?=[a-z0-9_*]{4,64}$)[a-z][a-z0-9_]{0,23}__(?:\*|[a-z][a-z0-9_]*)$/;
/** A tool name, optionally pinned to a lock version: `billing__create_refund@3`. */
export const TOOL_REF_PATTERN =
  /^(?=[a-z0-9_]{4,64}(?:@|$))[a-z][a-z0-9_]{0,23}__[a-z][a-z0-9_]*(?:@[1-9][0-9]{0,8})?$/;

/**
 * `<server>__<tool>`, the name an agent and Cedar see. Throws when the server
 * or the tool breaks its pattern, or the whole name passes 64 characters.
 */
export function toolName(server: string, tool: string): string {
  if (!SERVER_NAME_PATTERN.test(server)) {
    throw new RangeError(
      `"${server}" is not a server name. Start with a letter and use at most 24 lowercase letters, digits, and underscores.`,
    );
  }
  if (!TOOL_KEY_PATTERN.test(tool)) {
    throw new RangeError(
      `"${tool}" is not a tool key. Start with a letter and use lowercase letters, digits, and underscores.`,
    );
  }
  const name = `${server}${TOOL_SEPARATOR}${tool}`;
  if (name.length > TOOL_NAME_MAX) {
    throw new RangeError(
      `${name} is ${name.length} characters. A tool name is at most ${TOOL_NAME_MAX}.`,
    );
  }
  return name;
}

/** A tool name, or a pinned reference, read into its parts. */
export interface ParsedToolRef {
  server: string;
  tool: string;
  /** The lock version after `@`, or null for an unpinned name. */
  version: number | null;
}

/**
 * The server, tool, and pinned version of `billing__create_refund@3`, or null
 * for text that is not a tool reference. The server is the text before the
 * first `__`.
 */
export function parseToolRef(ref: string): ParsedToolRef | null {
  if (!TOOL_REF_PATTERN.test(ref)) return null;
  const [name, version] = ref.split("@") as [string, string | undefined];
  const at = name.indexOf(TOOL_SEPARATOR);
  return {
    server: name.slice(0, at),
    tool: name.slice(at + TOOL_SEPARATOR.length),
    version: version === undefined ? null : Number(version),
  };
}

/** Does a record's `tools` target (a name, or `<server>__*`) match this tool name? */
export function toolTargetMatches(target: string, name: string): boolean {
  if (target.endsWith(`${TOOL_SEPARATOR}*`)) {
    return name.startsWith(target.slice(0, -1));
  }
  return target === name;
}

// ── Credentials and repositories ─────────────────────────────────────────────

/** Every credential reference starts with this. */
export const CREDENTIAL_REF_PREFIX = "oxagen:credential/";
/** A credential's name in Oxagen's vault. */
export const CREDENTIAL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** `oxagen:credential/<name>`. */
export const CREDENTIAL_REF_PATTERN =
  /^oxagen:credential\/[a-z0-9][a-z0-9-]{0,62}$/;

/** `oxagen:credential/<name>`. The secret stays in the vault. */
export function credentialRef(name: string): string {
  if (!CREDENTIAL_NAME_PATTERN.test(name)) {
    throw new RangeError(
      `"${name}" is not a credential name. Use up to 63 lowercase letters, digits, and hyphens, starting with a letter or digit.`,
    );
  }
  return `${CREDENTIAL_REF_PREFIX}${name}`;
}

/** The name a credential reference names, or null for text that is not one. */
export function parseCredentialRef(ref: string): string | null {
  return CREDENTIAL_REF_PATTERN.test(ref)
    ? ref.slice(CREDENTIAL_REF_PREFIX.length)
    : null;
}

/**
 * `<host>/<owner>/<name>`, lowercase. The owner may hold slashes, for a
 * GitLab subgroup, and no segment is `.` or `..`.
 */
export const REPO_REF_PATTERN =
  /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/(?!\.\.?(?:\/|$))[a-z0-9_.-]+){2,}$/;

/** A code repository as records and workspace.toml name it: `github.com/a-intel/platform`. */
export function repoRef(host: string, owner: string, name: string): string {
  const ref = `${host}/${owner}/${name}`.toLowerCase();
  if (!REPO_REF_PATTERN.test(ref)) {
    throw new RangeError(
      `${ref} is not a repository reference. Write it as <host>/<owner>/<name>, such as github.com/a-intel/platform.`,
    );
  }
  return ref;
}

// ── Mentions ─────────────────────────────────────────────────────────────────

/** What a record body can @mention. */
export const MENTION_KINDS = ["record", "skill", "tool"] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

/** One @mention in a record body. */
export interface Mention {
  kind: MentionKind;
  /** A lineage for `record` and `skill`, a tool name for `tool`. */
  target: string;
  /** The mention's offset in the body, in UTF-16 units. */
  index: number;
}

const MENTION = /@(record|skill|tool):([a-z0-9][a-z0-9._-]*[a-z0-9])/g;

/**
 * Every `@record:`, `@skill:`, and `@tool:` mention in a body, in order,
 * including mentions inside code spans. A target that names nothing is still
 * returned: the `references` check decides what resolves.
 */
export function findMentions(body: string): Mention[] {
  return [...body.matchAll(MENTION)].map((match) => ({
    kind: match[1] as MentionKind,
    target: match[2] as string,
    index: match.index,
  }));
}

/** `@<kind>:<target>`. */
export function mentionText(kind: MentionKind, target: string): string {
  return `@${kind}:${target}`;
}

/** Is this a lineage, the name every record and agent file carries? */
export function isLineage(value: string): boolean {
  return CONTEXT_RECORD_LINEAGE.test(value);
}
