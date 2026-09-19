// The two files the init wizard drafts for a person to read and change before
// `open_init_pr` puts them on a branch (MC spec §10.2). Pure functions, so the
// wizard, its tests and the CLI's `oxagen repo init` draft the same text.

export type GovernanceMode = "solo" | "team" | "regulated";

export const GOVERNANCE_MODES: readonly GovernanceMode[] = [
  "solo",
  "team",
  "regulated",
];

/**
 * `.oxagen/rules/governance.toml` for a mode. The same lines the CLI drafts
 * (apps/cli/src/commands/repo.ts `draftGovernanceToml`): `open_init_pr`
 * refuses a file whose declared mode differs from the one chosen, so the
 * draft states it once and plainly.
 */
export function draftGovernanceToml(mode: GovernanceMode): string {
  return [
    "# Read on the production branch when a pull request is opened and again",
    "# when it is merged. A missing file means team.",
    `mode = "${mode}"`,
    `separation_of_duties = ${mode === "regulated" ? "true" : "false"}`,
    "",
  ].join("\n");
}

/** True for a character TOML forbids unescaped in a basic string: U+0000 to U+001F, and U+007F. */
function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
}

/** A TOML basic string: quotes and backslashes escaped, control characters dropped. */
function tomlString(value: string): string {
  const escaped = Array.from(value)
    .filter((char) => !isControl(char))
    .join("")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * `.oxagen/workspace.toml`: which workspace this repository belongs to, in
 * what role, and the branch `.oxagen/` is read from. Committed and reviewed.
 * The machine-local link, `.oxagen/workspace.json`, is the other file, and
 * the init pull request adds it to `.gitignore`.
 */
export function draftWorkspaceToml(args: {
  org: string;
  ws: string;
  wsName: string;
  repository: string;
  role: "main" | "linked";
  productionBranch: string;
}): string {
  return [
    "# Which Oxagen workspace this repository belongs to. Committed and",
    "# reviewed; .oxagen/workspace.json is one machine's link and is gitignored.",
    "[workspace]",
    `organization = ${tomlString(args.org)}`,
    `slug = ${tomlString(args.ws)}`,
    `name = ${tomlString(args.wsName)}`,
    "",
    "[repository]",
    `name = ${tomlString(args.repository)}`,
    `role = ${tomlString(args.role)}`,
    `production_branch = ${tomlString(args.productionBranch)}`,
    "",
  ].join("\n");
}

/**
 * The paths the page names. They are file names, not prose, so they live here
 * rather than in the message catalogue.
 */
export const WORKSPACE_TOML = ".oxagen/workspace.toml";
export const GOVERNANCE_TOML = ".oxagen/rules/governance.toml";
export const WORKSPACE_JSON = ".oxagen/workspace.json";

/** The files the init pull request carries, in the order the handler pushes them. */
export const INIT_FILES = [
  ".oxagen/workspace.toml",
  ".oxagen/rules/governance.toml",
  ".oxagen/rules/.gitkeep",
  ".oxagen/proposals/.gitkeep",
  ".oxagen/agents/.gitkeep",
  ".gitignore",
] as const;

/** The branch every init pull request is opened from. */
export const INIT_BRANCH = "oxagen/init";
