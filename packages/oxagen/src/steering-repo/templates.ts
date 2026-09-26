// templates.ts: the files Oxagen writes in a steering repo's first commit
// (steering-repo-spec, Provisioning, Repository layout, and Managed blocks).
//
// Oxagen's text in AGENTS.md, CLAUDE.md, and README.md sits between two
// marker lines, and the first marker carries a hash of the text between
// them. People write anything outside the block. The `owned` check recomputes
// the hash on every steering PR with the functions below, so a template and
// the check can never disagree on it.
import { sha256Digest } from "@oxagen/run-evidence";
import type { FileIssue } from "./files";
import { REQUIRED_CHECK_NAME } from "./names";
import {
  AGENTS_MD_PATH,
  CLAUDE_MD_PATH,
  GITATTRIBUTES_PATH,
  GOVERNANCE_TOML_PATH,
  README_PATH,
  WORKSPACE_TOML_PATH,
} from "./paths";
import { schemaDirective, schemaUrl } from "./schema-ids";

// ── Managed blocks ───────────────────────────────────────────────────────────

const BEGIN_PREFIX = "<!-- oxagen:begin managed sha256:";
const BEGIN_LINE = /^<!-- oxagen:begin managed sha256:([0-9a-f]{16}) -->$/;
/** The line that ends a managed block. */
export const MANAGED_BLOCK_END = "<!-- oxagen:end managed -->";

/** The first 16 hex characters of sha256 over the block's text. */
export function managedBlockHash(content: string): string {
  return sha256Digest(new TextEncoder().encode(content)).slice(7, 23);
}

/**
 * A managed block: the begin marker with the hash, the text, and the end
 * marker, each on its own line. The text gains a final newline if it lacks one.
 */
export function renderManagedBlock(content: string): string {
  const text = content.endsWith("\n") ? content : `${content}\n`;
  return `${BEGIN_PREFIX}${managedBlockHash(text)} -->\n${text}${MANAGED_BLOCK_END}\n`;
}

/** A managed block as a file holds it. Lines are 1-based. */
export interface ManagedBlock {
  begin_line: number;
  end_line: number;
  /** The text between the markers, each line with its newline. */
  content: string;
  declared_hash: string;
  actual_hash: string;
  /** True when the text still matches the hash its marker carries. */
  intact: boolean;
}

function markerIssue(line: number, message: string) {
  return { ok: false as const, issue: { line, field: null, message } };
}

/**
 * Find a file's managed block. `block` is null when the file has none. A
 * file with a second block, a begin marker with no end, or a marker whose
 * hash is unreadable is an issue.
 */
export function readManagedBlock(
  text: string,
): { ok: true; block: ManagedBlock | null } | { ok: false; issue: FileIssue } {
  const lines = text.split("\n");
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith(BEGIN_PREFIX)) begins.push(index);
    if (line === MANAGED_BLOCK_END) ends.push(index);
  });
  if (begins.length === 0 && ends.length === 0) return { ok: true, block: null };
  const begin = begins[0];
  const end = ends[0];
  if (begins.length > 1 || ends.length > 1) {
    return markerIssue(
      ((begins.length > 1 ? begins[1] : ends[1]) as number) + 1,
      "the file holds a second managed block",
    );
  }
  if (begin === undefined || end === undefined || end < begin) {
    return markerIssue(
      ((begin ?? end) as number) + 1,
      "the managed block needs one begin marker and one end marker after it",
    );
  }
  const declared = BEGIN_LINE.exec(lines[begin] as string);
  if (!declared) {
    return markerIssue(begin + 1, "the begin marker's hash is not 16 hex characters");
  }
  const content = lines
    .slice(begin + 1, end)
    .map((line) => `${line}\n`)
    .join("");
  const actual = managedBlockHash(content);
  return {
    ok: true,
    block: {
      begin_line: begin + 1,
      end_line: end + 1,
      content,
      declared_hash: declared[1] as string,
      actual_hash: actual,
      intact: declared[1] === actual,
    },
  };
}

// ── The first commit ─────────────────────────────────────────────────────────

/** What the templates need to know about the repository they seed. */
export interface SteeringRepoTemplateInput {
  provider: "github" | "gitlab";
  /** The organization's slug, such as `a-intel`. */
  organization: string;
  /** The repository as its host names it, such as `a-intel/oxagen-core-platform`. */
  repository: string;
  /** A workspace's steering repo, or the organization's repository `<org>/oxagen`. */
  scope:
    | { kind: "workspace"; slug: string; label: string }
    | { kind: "organization" };
}

function steersWhom(input: SteeringRepoTemplateInput): string {
  return input.scope.kind === "workspace"
    ? `every agent in the ${input.scope.label} workspace`
    : `every agent in every workspace of the ${input.organization} organization`;
}

/** AGENTS.md: how to write a record here, for an agent that opens the repository. */
export function agentsMdTemplate(input: SteeringRepoTemplateInput): string {
  const block = [
    `# ${input.repository}`,
    "",
    `This repository steers ${steersWhom(input)}.`,
    "Oxagen publishes it when a steering PR merges.",
    "Nothing here takes effect before that.",
    "",
    "## Write a record",
    "",
    `- One idea per file: steering/<any folder>/<lineage>.md, lineage like ${input.organization}.billing.refunds-over-100.`,
    `- Frontmatter fields and kinds: ${schemaUrl("steering-record/v1")}`,
    "- Write the body to the agent that will read it, in the imperative.",
    "- Do not type id or hash. Oxagen writes them on merge.",
    "- Keep must and should records under 120 words. Everything else loads on demand.",
    "- Run `oxagen check` before you push.",
    "",
    "## Do not edit",
    "",
    "This block, policy/schema.cedarschema, steering/promotions/, and",
    "tools/servers/*/tools.lock.json.",
  ].join("\n");
  return `${renderManagedBlock(block)}\nNotes your team adds go below the block.\n`;
}

/** CLAUDE.md: one line that imports AGENTS.md. */
export function claudeMdTemplate(): string {
  return renderManagedBlock("@AGENTS.md");
}

const HELD_SETTINGS: Record<SteeringRepoTemplateInput["provider"], string[]> = {
  github: [
    "- The repository is private.",
    `- The ruleset Oxagen steering on main requires a pull request and the ${REQUIRED_CHECK_NAME} check, and blocks force pushes and deletion.`,
    "- The ruleset Oxagen merges on main lets only Oxagen update it.",
    "- Pull requests merge by squash only, and head branches are deleted after a merge.",
    "- GitHub Actions is off.",
    "- The steering environment records each published version.",
  ],
  gitlab: [
    "- The project is private.",
    "- The protected branch main takes no pushes, and only the Oxagen bot merges into it.",
    `- Merge requests squash, and wait for the ${REQUIRED_CHECK_NAME} commit status.`,
    "- Source branches are deleted after a merge.",
    "- CI/CD is off.",
  ],
};

/** README.md: what the repository is, who reviews it, and the settings Oxagen holds. */
export function readmeTemplate(input: SteeringRepoTemplateInput): string {
  const holds =
    input.scope.kind === "workspace"
      ? "It holds the workspace's steering records, skills, tool servers, agents, and policies."
      : "It holds the organization's records, and every workspace in the organization inherits them.";
  const block = [
    `# ${input.repository}`,
    "",
    `This repository steers ${steersWhom(input)}.`,
    holds,
    "Oxagen publishes it when a steering PR merges, and runs read the published version.",
    "",
    "## Changes",
    "",
    "Every change arrives as a steering PR, opened from Oxagen, from an agent's MCP tool, or from a clone.",
    "steering/governance.toml sets who reviews each change.",
    `Only Oxagen merges into main, and only after the ${REQUIRED_CHECK_NAME} check passes.`,
    "",
    "## Settings Oxagen holds",
    "",
    "Oxagen sets these and reads them back before every merge.",
    "When one changes, every pull request fails and nothing publishes until an admin selects Repair settings in Oxagen.",
    "",
    ...HELD_SETTINGS[input.provider],
  ].join("\n");
  return renderManagedBlock(block);
}

/** .gitattributes: LF line endings for every file. */
export function gitattributesTemplate(): string {
  return "* text=auto eol=lf\n";
}

/** workspace.toml in a new steering repo: the workspace, and nothing linked yet. */
export function workspaceTomlTemplate(
  organization: string,
  workspace: string,
): string {
  return [
    schemaDirective("workspace/v1"),
    'schema = "workspace/v1"',
    `organization = ${JSON.stringify(organization)}`,
    `workspace = ${JSON.stringify(workspace)}`,
    "",
  ].join("\n");
}

/** steering/governance.toml in a new steering repo: `solo` mode. */
export function governanceTomlTemplate(): string {
  return [
    schemaDirective("governance/v1"),
    'schema = "governance/v1"',
    'mode = "solo"',
    "",
  ].join("\n");
}

/**
 * Every file of a new repository's first commit, in the order Oxagen writes
 * them. An organization repository has no workspace.toml.
 */
export function firstCommitFiles(
  input: SteeringRepoTemplateInput,
): { path: string; content: string }[] {
  const files = [
    { path: README_PATH, content: readmeTemplate(input) },
    { path: AGENTS_MD_PATH, content: agentsMdTemplate(input) },
    { path: CLAUDE_MD_PATH, content: claudeMdTemplate() },
    { path: GITATTRIBUTES_PATH, content: gitattributesTemplate() },
  ];
  if (input.scope.kind === "workspace") {
    files.push({
      path: WORKSPACE_TOML_PATH,
      content: workspaceTomlTemplate(input.organization, input.scope.slug),
    });
  }
  files.push({ path: GOVERNANCE_TOML_PATH, content: governanceTomlTemplate() });
  return files;
}
