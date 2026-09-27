// paths.ts: every path in a steering repo, relative to the repository root
// (steering-repo-spec, Shared contract and Repository layout).
//
// The module imports nothing, so the CLI and the app can read it without
// loading zod or the contract registry. A directory carries no trailing slash,
// and a file path joins a directory and a name with "/".

// ── The steering repo ────────────────────────────────────────────────────────

/** How to write a record here, for an agent. Oxagen writes a managed block. */
export const AGENTS_MD_PATH = "AGENTS.md";
/** One line that imports AGENTS.md. Oxagen writes a managed block. */
export const CLAUDE_MD_PATH = "CLAUDE.md";
/** What the repository is, for people. Oxagen writes a managed block. */
export const README_PATH = "README.md";
/** Pins LF line endings. */
export const GITATTRIBUTES_PATH = ".gitattributes";
/** Linked code repositories, budget, code checks, tools, and embeddings. A workspace repo only. */
export const WORKSPACE_TOML_PATH = "workspace.toml";
/** One `agent/v1` file per agent. */
export const AGENTS_DIR = "agents";
/** Steering records and skills. Folders under it carry no meaning. */
export const STEERING_DIR = "steering";
/** Governance mode, reviewers, and memory settings. */
export const GOVERNANCE_TOML_PATH = "steering/governance.toml";
/** The hash-chained ledger, one file per period. Oxagen writes it. */
export const PROMOTIONS_DIR = "steering/promotions";
/** One folder per skill, named for its lineage. */
export const SKILLS_DIR = "steering/skills";
/** Memories a memory PR promoted. The curator writes them. */
export const MEMORY_DIR = "steering/memory";
/** Tool servers and toolbelts. */
export const TOOLS_DIR = "tools";
/** One folder per MCP server. */
export const TOOL_SERVERS_DIR = "tools/servers";
/** Named toolbelts. Empty on day one. */
export const TOOLBELTS_DIR = "tools/toolbelts";
/** Cedar policies and their tests. */
export const POLICY_DIR = "policy";
/** The Cedar schema. Oxagen writes it. */
export const CEDAR_SCHEMA_PATH = "policy/schema.cedarschema";

/** A skill folder's record. */
export const SKILL_FILE_NAME = "SKILL.md";
/** A server's source, auth, environments, exposure, and sync (`mcp-server/v1`). */
export const SERVER_TOML_NAME = "server.toml";
/** A server's imported tools and their classification (`mcp-tools/v1`). */
export const TOOLS_TOML_NAME = "tools.toml";
/** A server's reviewed upstream definitions (`mcp-tools-lock/v1`). Oxagen writes it. */
export const TOOLS_LOCK_NAME = "tools.lock.json";

/** `agents/<name>.toml`. */
export function agentFilePath(name: string): string {
  return `${AGENTS_DIR}/${name}.toml`;
}

/** `<lineage>.md`: a record file is named for its lineage, in any folder under steering/. */
export function recordFileName(lineage: string): string {
  return `${lineage}.md`;
}

/** `steering/skills/<lineage>`. */
export function skillFolderPath(lineage: string): string {
  return `${SKILLS_DIR}/${lineage}`;
}

/** `steering/skills/<lineage>/SKILL.md`. */
export function skillFilePath(lineage: string): string {
  return `${skillFolderPath(lineage)}/${SKILL_FILE_NAME}`;
}

/** `tools/servers/<name>`. */
export function serverFolderPath(server: string): string {
  return `${TOOL_SERVERS_DIR}/${server}`;
}

/** `tools/servers/<name>/server.toml`. */
export function serverTomlPath(server: string): string {
  return `${serverFolderPath(server)}/${SERVER_TOML_NAME}`;
}

/** `tools/servers/<name>/tools.toml`. */
export function toolsTomlPath(server: string): string {
  return `${serverFolderPath(server)}/${TOOLS_TOML_NAME}`;
}

/** `tools/servers/<name>/tools.lock.json`. */
export function toolsLockPath(server: string): string {
  return `${serverFolderPath(server)}/${TOOLS_LOCK_NAME}`;
}

/** `tools/toolbelts/<name>.toml`. */
export function toolbeltFilePath(name: string): string {
  return `${TOOLBELTS_DIR}/${name}.toml`;
}

/** `policy/<group>.cedar`. */
export function policyFilePath(group: string): string {
  return `${POLICY_DIR}/${group}.cedar`;
}

/** `policy/<group>.tests.jsonl`, the tests beside a policy file. */
export function policyTestsPath(group: string): string {
  return `${POLICY_DIR}/${group}.tests.jsonl`;
}

// ── The ledger ───────────────────────────────────────────────────────────────

/** How often the ledger starts a new file (`[ledger] rotate`). */
export type LedgerRotation = "day" | "week" | "month" | "year";

/** The most files one period can hold: `<period>.999.jsonl`. */
export const LEDGER_FILES_PER_PERIOD_MAX = 999;

/**
 * The period a ledger line written at `at` belongs to, in UTC:
 * `2026-09-26` by day, `2026-W39` by ISO week, `2026-09` by month, and
 * `2026` by year.
 */
export function ledgerPeriod(at: Date, rotate: LedgerRotation): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  if (rotate === "year") return String(year);
  if (rotate === "month") return `${year}-${month}`;
  if (rotate === "day") {
    const day = String(at.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  // ISO 8601: the week holds that year's first Thursday, and a week belongs
  // to the year of its Thursday.
  const thursday = new Date(Date.UTC(year, at.getUTCMonth(), at.getUTCDate()));
  const weekday = thursday.getUTCDay() === 0 ? 7 : thursday.getUTCDay();
  thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
  const weekYear = thursday.getUTCFullYear();
  const dayOfYear =
    (thursday.getTime() - Date.UTC(weekYear, 0, 1)) / 86_400_000 + 1;
  const week = String(Math.ceil(dayOfYear / 7)).padStart(2, "0");
  return `${weekYear}-W${week}`;
}

/**
 * The name of a period's `n`th ledger file: `2026-09.jsonl` first, then
 * `2026-09.002.jsonl` once the first reaches `[ledger] max_lines`.
 */
export function ledgerFileName(period: string, n = 1): string {
  if (!Number.isInteger(n) || n < 1 || n > LEDGER_FILES_PER_PERIOD_MAX) {
    throw new RangeError(
      `a ledger file number is a whole number from 1 to ${LEDGER_FILES_PER_PERIOD_MAX}, not ${n}`,
    );
  }
  return n === 1
    ? `${period}.jsonl`
    : `${period}.${String(n).padStart(3, "0")}.jsonl`;
}

/** `steering/promotions/<period>.jsonl`, or `<period>.<nnn>.jsonl` from the second file on. */
export function ledgerFilePath(period: string, n = 1): string {
  return `${PROMOTIONS_DIR}/${ledgerFileName(period, n)}`;
}

const LEDGER_FILE =
  /^(\d{4}(?:-\d{2}(?:-\d{2})?|-W\d{2})?)(?:\.(\d{3}))?\.jsonl$/;

/**
 * The period and file number a ledger file name carries, or null for a name
 * that is not a ledger file. `2026-09.002.jsonl` is `{ period: "2026-09", n: 2 }`.
 */
export function parseLedgerFileName(
  name: string,
): { period: string; n: number } | null {
  const match = LEDGER_FILE.exec(name);
  if (!match) return null;
  const n = match[2] === undefined ? 1 : Number(match[2]);
  if (n < 2 && match[2] !== undefined) return null;
  return { period: match[1] as string, n };
}

// ── What a path holds ────────────────────────────────────────────────────────

/** Every kind of file the contract places in a steering repo. */
export type SteeringRepoFileKind =
  | "agents-md"
  | "claude-md"
  | "readme"
  | "gitattributes"
  | "workspace"
  | "governance"
  | "ledger"
  | "record"
  | "skill-record"
  | "skill-asset"
  | "agent"
  | "server"
  | "server-tools"
  | "server-lock"
  | "server-definition"
  | "server-test"
  | "toolbelt"
  | "cedar-schema"
  | "policy"
  | "policy-tests"
  | "unknown";

const ROOT_FILES: Readonly<Record<string, SteeringRepoFileKind>> = {
  [AGENTS_MD_PATH]: "agents-md",
  [CLAUDE_MD_PATH]: "claude-md",
  [README_PATH]: "readme",
  [GITATTRIBUTES_PATH]: "gitattributes",
  [WORKSPACE_TOML_PATH]: "workspace",
  [GOVERNANCE_TOML_PATH]: "governance",
  [CEDAR_SCHEMA_PATH]: "cedar-schema",
};

const SERVER_FILES: Readonly<Record<string, SteeringRepoFileKind>> = {
  [SERVER_TOML_NAME]: "server",
  [TOOLS_TOML_NAME]: "server-tools",
  [TOOLS_LOCK_NAME]: "server-lock",
  "openapi.yaml": "server-definition",
  "overlay.yaml": "server-definition",
  "schema.graphql": "server-definition",
};

function classifySteering(parts: readonly string[]): SteeringRepoFileKind {
  const name = parts[parts.length - 1] as string;
  if (parts[1] === "promotions") {
    return parts.length === 3 && parseLedgerFileName(name)
      ? "ledger"
      : "unknown";
  }
  if (parts[1] === "skills" && parts.length > 3) {
    return parts.length === 4 && name === SKILL_FILE_NAME
      ? "skill-record"
      : "skill-asset";
  }
  return name.endsWith(".md") ? "record" : "unknown";
}

function classifyServer(parts: readonly string[]): SteeringRepoFileKind {
  // tools/servers/<name>/<file>, or deeper under proto/ and tests/.
  if (parts.length < 4) return "unknown";
  const inner = parts[3] as string;
  if (parts.length === 4) return SERVER_FILES[inner] ?? "unknown";
  if (inner === "proto") return "server-definition";
  if (inner === "tests") return "server-test";
  return "unknown";
}

/**
 * What a path in a steering repo holds, by the layout alone. A path the
 * contract gives no place is `unknown`.
 */
export function classifySteeringRepoPath(path: string): SteeringRepoFileKind {
  const root = ROOT_FILES[path];
  if (root) return root;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return "unknown";
  }
  const name = parts[parts.length - 1] as string;
  switch (parts[0]) {
    case STEERING_DIR:
      return classifySteering(parts);
    case AGENTS_DIR:
      return parts.length === 2 && name.endsWith(".toml") ? "agent" : "unknown";
    case TOOLS_DIR:
      if (parts[1] === "servers") return classifyServer(parts);
      return parts[1] === "toolbelts" &&
        parts.length === 3 &&
        name.endsWith(".toml")
        ? "toolbelt"
        : "unknown";
    case POLICY_DIR:
      if (parts.length !== 2) return "unknown";
      if (name.endsWith(".tests.jsonl")) return "policy-tests";
      return name.endsWith(".cedar") ? "policy" : "unknown";
    default:
      return "unknown";
  }
}

/**
 * The lineage a record's path names: the file name without `.md`, or the
 * folder name for a skill's `SKILL.md`. Null for a path that holds no record.
 */
export function recordLineageFromPath(path: string): string | null {
  const kind = classifySteeringRepoPath(path);
  const parts = path.split("/");
  if (kind === "skill-record") return parts[2] as string;
  if (kind === "record") return (parts[parts.length - 1] as string).slice(0, -3);
  return null;
}

// ── Today's layout ───────────────────────────────────────────────────────────
//
// Until lane S10 moves each workspace, steering lives under `.oxagen/` in the
// workspace's main repository (ADR-099). The code that reads that layout
// imports these names, so it reads the same paths it read before this module
// existed. S10 deletes this section.

/** The steering tree in a main repository. */
export const LEGACY_OXAGEN_DIR = ".oxagen";
/** v0.1 record files (`context-record/v0.1`). */
export const LEGACY_RULES_DIR = ".oxagen/rules";
/** The governance file in a main repository. */
export const LEGACY_GOVERNANCE_PATH = ".oxagen/rules/governance.toml";
/** The v0.1 workspace file in a main repository. */
export const LEGACY_WORKSPACE_TOML_PATH = ".oxagen/workspace.toml";
/** Governed skills in a main repository. */
export const LEGACY_SKILLS_DIR = ".oxagen/skills";
/** The skills configuration in a main repository. */
export const LEGACY_SKILLS_CONFIG_PATH = ".oxagen/skills.toml";
/** The empty files the init pull request commits so git keeps the two folders. */
export const LEGACY_KEEP_FILES = [
  ".oxagen/rules/.gitkeep",
  ".oxagen/proposals/.gitkeep",
] as const;

// ── A code checkout ──────────────────────────────────────────────────────────

/**
 * One machine's link to its workspace, in a code checkout. Gitignored, never
 * published, and not part of the move: the spec keeps it where it is.
 */
export const WORKSPACE_LINK_PATH = ".oxagen/workspace.json";
