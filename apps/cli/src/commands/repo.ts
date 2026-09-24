/**
 * `oxagen repo …` — the workspace's repositories (Mission Control spec §10.1;
 * ADR-099). A workspace has one main repository, bound when the workspace is
 * created, and any number of linked ones. This surface reads and changes the
 * linked set; the main repository is neither linked nor unlinked here.
 *
 *   oxagen repo list                    — every repository the workspace
 *                                         binds, main first (list_repositories)
 *   oxagen repo link <owner/name>       — link a repository the workspace's
 *                                         GitHub App installation reaches
 *                                         (link_repository)
 *   oxagen repo unlink <bindingId>      — remove a linked repository by the
 *                                         `rpb_…` id `repo list` shows
 *                                         (unlink_repository)
 *   oxagen repo tree <bindingId>        — what the repository holds under
 *                                         .oxagen/ on its production branch
 *                                         (get_repository_tree)
 *   oxagen repo branch <bindingId> <b>  — confirm or change the production
 *                                         branch (set_production_branch)
 *   oxagen repo init <bindingId>        — open the pull request that adds
 *                                         .oxagen/ (open_init_pr)
 *
 * Every call goes through the shared org-scoped API client in lib/api.ts:
 * `repositories` (GET), `repository/link` and `repository/unlink` (POST),
 * `repository/tree` (POST), `repository/production-branch` (POST) and
 * `repository/init-pr` (POST). The
 * caller never names a GitHub installation. The API takes it from the
 * workspace's GitHub connection.
 *
 * Output discipline (ADR-023 §4): `--json` emits the exact contract payload
 * as one line on stdout; pretty mode prints a table (list) or one line (link,
 * unlink); failures are uniform stderr lines (exit 2 for a bad argument,
 * exit 1 for an API failure).
 */
import { readFile } from "node:fs/promises";
import { apiGetOrThrow, apiPostOrThrow, printTable } from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

// ── Output shapes (mirror the repository.* contract outputs) ─────────────────

export type RepositoryRole = "main" | "linked";

/** One row of `list_repositories`. */
export interface RepositoryRow {
  bindingId: string;
  role: RepositoryRole;
  owner: string;
  name: string;
  fullName: string;
  defaultRef: string;
  htmlUrl: string;
  boundAt: string;
  connectionLive: boolean;
  /** Whether GitHub can deliver the repository's events at all. */
  events:
    | "installed"
    | "suspended"
    | "uninstalled"
    | "paused"
    | "retired"
    | "unknown";
}

/** The `list_repositories` output. */
export interface RepositoryListResult {
  repositories: RepositoryRow[];
}

/** The `link_repository` output. */
export interface RepositoryLinkResult {
  bindingId: string;
  connectionId: string;
  fullName: string;
  defaultRef: string;
  role: "linked";
  linkedAt: string;
}

/** The `unlink_repository` output. */
export interface RepositoryUnlinkResult {
  bindingId: string;
  fullName: string;
  unlinkedAt: string;
}

/** The `get_repository_tree` output. */
export interface RepositoryTreeResult {
  bindingId: string;
  role: RepositoryRole;
  fullName: string;
  productionBranch: string;
  githubDefaultBranch: string;
  head: string | null;
  oxagen: { present: boolean; files: string[] };
  workspaceToml: string | null;
  governanceToml: string | null;
  governanceMode: "solo" | "team" | "regulated" | "absent" | "invalid";
  initPullRequest: { number: number; htmlUrl: string } | null;
  readAt: string;
}

/** The `set_production_branch` output. */
export interface ProductionBranchResult {
  bindingId: string;
  fullName: string;
  productionBranch: string;
  previousBranch: string;
  changed: boolean;
  setAt: string;
}

/** The `open_init_pr` output. */
export interface InitPrResult {
  bindingId: string;
  fullName: string;
  branch: string;
  base: string;
  pullRequest: { number: number; htmlUrl: string };
  files: string[];
  reused: boolean;
  openedAt: string;
}

export type GovernanceMode = "solo" | "team" | "regulated";
const GOVERNANCE_MODES: readonly GovernanceMode[] = [
  "solo",
  "team",
  "regulated",
];

/** `.oxagen/rules/governance.toml` for a mode, as the Repositories page drafts it. */
export function draftGovernanceToml(mode: GovernanceMode): string {
  return [
    "# Read on the production branch when a pull request is opened and again",
    "# when it is merged. A missing file means team.",
    `mode = "${mode}"`,
    `separation_of_duties = ${mode === "regulated" ? "true" : "false"}`,
    "",
  ].join("\n");
}

interface RepoOptions {
  json?: boolean;
}

function usage(writer: CommandWriter, message: string, line: string): void {
  writer.writeErr(`error: ${message}`);
  writer.writeErr(`usage: ${line}`);
  process.exitCode = 2;
}

/**
 * Split `owner/name` into its two parts. Exactly one slash, neither side
 * empty; the API applies GitHub's own spelling rules after that.
 */
export function parseRepositoryRef(
  ref: string,
): { owner: string; name: string } | null {
  const parts = ref.trim().split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (owner.length === 0 || name.length === 0) return null;
  return { owner, name };
}

const connectionState = (live: boolean): string => (live ? "live" : "retired");

// ── repo list ────────────────────────────────────────────────────────────────

export async function repoList(
  opts: RepoOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: RepositoryListResult;
  try {
    result = await apiGetOrThrow<RepositoryListResult>("repositories");
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  if (result.repositories.length === 0) {
    writer.write(
      "No repositories are bound to this workspace. Bind a main repository in Oxagen, then link more with `oxagen repo link <owner/name>`.",
    );
    return;
  }
  printTable(
    ["ROLE", "REPOSITORY", "DEFAULT REF", "BINDING", "CONNECTION", "EVENTS"],
    result.repositories.map((r) => [
      r.role,
      r.fullName,
      r.defaultRef,
      r.bindingId,
      connectionState(r.connectionLive),
      r.events,
    ]),
    writer,
  );
  const retired = result.repositories.filter((r) => !r.connectionLive);
  if (retired.length > 0) {
    writer.write("");
    writer.write(
      `${retired.length} of ${result.repositories.length} sit on a retired GitHub connection and do not resolve. Reconnect GitHub from the Repositories page.`,
    );
  }
}

// ── repo link ────────────────────────────────────────────────────────────────

export async function repoLink(
  ref: string,
  opts: RepoOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const parsed = parseRepositoryRef(ref);
  if (!parsed) {
    return usage(
      writer,
      `expected <owner/name>, got ${JSON.stringify(ref)}`,
      "oxagen repo link <owner/name> [--json]",
    );
  }
  const out = createOutput({ json: opts.json }, writer);
  let result: RepositoryLinkResult;
  try {
    result = await apiPostOrThrow<RepositoryLinkResult>("repository/link", {
      provider: "github",
      owner: parsed.owner,
      name: parsed.name,
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(
    `linked ${result.fullName} · ${result.defaultRef} · ${result.bindingId}`,
  );
  writer.write(
    "Runs on this repository can cite it in a grant's resource_scope; unlink it with `oxagen repo unlink <bindingId>`.",
  );
}

// ── repo unlink ──────────────────────────────────────────────────────────────

export async function repoUnlink(
  bindingId: string,
  opts: RepoOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const id = bindingId.trim();
  if (id.length === 0) {
    return usage(
      writer,
      "a binding id is required",
      "oxagen repo unlink <bindingId> [--json]",
    );
  }
  const out = createOutput({ json: opts.json }, writer);
  let result: RepositoryUnlinkResult;
  try {
    result = await apiPostOrThrow<RepositoryUnlinkResult>("repository/unlink", {
      bindingId: id,
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(`unlinked ${result.fullName} · ${result.bindingId}`);
  writer.write(
    "Its binding versions stay as evidence for the runs that cited them. Link it again to write the next version.",
  );
}

// ── repo tree ────────────────────────────────────────────────────────────────

export async function repoTree(
  bindingId: string,
  opts: RepoOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const id = bindingId.trim();
  if (id.length === 0) {
    return usage(
      writer,
      "a binding id is required",
      "oxagen repo tree <bindingId> [--json]",
    );
  }
  const out = createOutput({ json: opts.json }, writer);
  let result: RepositoryTreeResult;
  try {
    result = await apiPostOrThrow<RepositoryTreeResult>("repository/tree", {
      bindingId: id,
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(
    `${result.fullName} · ${result.role} · ${result.productionBranch} at ${result.head ?? "(branch not found)"}`,
  );
  if (result.githubDefaultBranch !== result.productionBranch) {
    writer.write(
      `GitHub's default branch is ${result.githubDefaultBranch}. The production branch stays ${result.productionBranch} until you change it with \`oxagen repo branch\`.`,
    );
  }
  if (!result.oxagen.present) {
    writer.write(
      result.initPullRequest === null
        ? "No .oxagen/ on the production branch. Add it with `oxagen repo init`."
        : `No .oxagen/ yet. The init pull request is open: ${result.initPullRequest.htmlUrl}`,
    );
    return;
  }
  writer.write(`governance mode: ${result.governanceMode}`);
  for (const file of result.oxagen.files) writer.write(`  ${file}`);
}

// ── repo branch ──────────────────────────────────────────────────────────────

export async function repoBranch(
  bindingId: string,
  branch: string,
  opts: RepoOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const id = bindingId.trim();
  const name = branch.trim();
  if (id.length === 0 || name.length === 0) {
    return usage(
      writer,
      "a binding id and a branch are required",
      "oxagen repo branch <bindingId> <branch> [--json]",
    );
  }
  const out = createOutput({ json: opts.json }, writer);
  let result: ProductionBranchResult;
  try {
    result = await apiPostOrThrow<ProductionBranchResult>(
      "repository/production-branch",
      { bindingId: id, branch: name },
    );
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(
    result.changed
      ? `${result.fullName}: production branch ${result.previousBranch} → ${result.productionBranch} · ${result.bindingId}`
      : `${result.fullName}: production branch is already ${result.productionBranch}; nothing was written`,
  );
}

// ── repo init ────────────────────────────────────────────────────────────────

interface InitOptions extends RepoOptions {
  mode?: string;
  workspaceToml?: string;
  governanceToml?: string;
}

export async function repoInit(
  bindingId: string,
  opts: InitOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const line =
    "oxagen repo init <bindingId> --workspace-toml <file> [--mode solo|team|regulated] [--governance-toml <file>] [--json]";
  const id = bindingId.trim();
  if (id.length === 0) {
    return usage(writer, "a binding id is required", line);
  }
  const mode = (opts.mode ?? "team") as GovernanceMode;
  if (!GOVERNANCE_MODES.includes(mode)) {
    return usage(
      writer,
      `expected a mode of solo, team or regulated, got ${JSON.stringify(opts.mode)}`,
      line,
    );
  }
  if (opts.workspaceToml === undefined) {
    return usage(writer, "--workspace-toml is required", line);
  }
  let workspaceToml: string;
  let governanceToml: string;
  try {
    workspaceToml = await readFile(opts.workspaceToml, "utf8");
    governanceToml =
      opts.governanceToml === undefined
        ? draftGovernanceToml(mode)
        : await readFile(opts.governanceToml, "utf8");
  } catch (err) {
    return usage(
      writer,
      `could not read a file: ${err instanceof Error ? err.message : String(err)}`,
      line,
    );
  }
  const out = createOutput({ json: opts.json }, writer);
  let result: InitPrResult;
  try {
    result = await apiPostOrThrow<InitPrResult>("repository/init-pr", {
      bindingId: id,
      governanceMode: mode,
      workspaceToml,
      governanceToml,
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  writer.write(
    result.reused
      ? `An init pull request is already open on ${result.fullName}: ${result.pullRequest.htmlUrl}`
      : `Opened ${result.pullRequest.htmlUrl} on ${result.fullName}: ${result.branch} → ${result.base}, ${result.files.length} files`,
  );
  writer.write(
    "Nothing reaches the production branch until a person merges it.",
  );
}

// ── governance ──────────────────────────────────────────────────────────────

/** `set_governance_mode`'s answer, as the API returns it. */
interface GovernanceModeResult {
  outcome: "applied" | "proposed" | "unchanged";
  requestedMode: GovernanceMode;
  previousMode: GovernanceMode | null;
  effectiveMode: GovernanceMode | null;
  fullName: string;
  productionBranch: string;
  commitSha: string | null;
  pullRequest: { number: number; htmlUrl: string; reused: boolean } | null;
  overrodeReview: boolean;
}

export interface GovernanceOptions {
  json?: boolean;
  workspace?: string;
  applyNow?: boolean;
}

/**
 * `oxagen repo governance --mode <mode>` — set the workspace's steering
 * governance mode by writing `.oxagen/rules/governance.toml`.
 *
 * The route is not this command's choice: under `solo` the server commits to
 * the production branch, and under `team` or `regulated` it opens a pull
 * request for a person to merge. `--apply-now` asks it to commit anyway, which
 * only an org Owner or Admin, or a workspace Owner or Admin, may do — and which
 * is recorded as `steering.governance_overridden`.
 */
export async function repoGovernance(
  opts: GovernanceOptions & { mode?: string } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const line =
    "oxagen repo governance --mode solo|team|regulated [--workspace <wrk_…>] [--apply-now] [--json]";
  const mode = opts.mode as GovernanceMode | undefined;
  if (mode === undefined || !GOVERNANCE_MODES.includes(mode)) {
    return usage(
      writer,
      `expected a mode of solo, team or regulated, got ${JSON.stringify(opts.mode)}`,
      line,
    );
  }
  const out = createOutput({ json: opts.json }, writer);
  let result: GovernanceModeResult;
  try {
    result = await apiPostOrThrow<GovernanceModeResult>(
      "context/governance-mode",
      {
        mode,
        applyImmediately: opts.applyNow === true,
        ...(opts.workspace === undefined
          ? {}
          : { workspaceId: opts.workspace }),
      },
    );
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  if (result.outcome === "unchanged") {
    writer.write(
      `${result.fullName} already runs under ${result.requestedMode}; nothing was written.`,
    );
    return;
  }
  if (result.outcome === "applied") {
    writer.write(
      `${result.fullName} now runs under ${result.requestedMode} (${result.productionBranch}, ${result.commitSha ?? "committed"}).`,
    );
    if (result.overrodeReview) {
      // Said plainly, because the override is the part someone may later ask
      // about, and the CLI is where it is easiest to spend without noticing.
      writer.write(
        `Committed without review, which ${result.previousMode ?? "the mode in force"} asks for. Recorded as steering.governance_overridden.`,
      );
    }
    return;
  }
  writer.write(
    result.pullRequest?.reused === true
      ? `Updated the open pull request on ${result.fullName}: ${result.pullRequest.htmlUrl}`
      : `Opened ${result.pullRequest?.htmlUrl ?? "a pull request"} on ${result.fullName}.`,
  );
  writer.write(
    `${result.fullName} still runs under ${result.effectiveMode ?? "an unreadable governance.toml"} until a person merges it. Pass --apply-now to commit instead.`,
  );
}
