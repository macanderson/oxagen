// The Repositories page's view models (MC spec §10.1, §10.2, §11.4): the
// workspace's main repository, whether a GitHub App installation is attached,
// the set of repositories that installation reaches, what each bound
// repository holds under `.oxagen/`, and the pull requests Oxagen has open.
//
// The main repo is where `.oxagen/` lives — published steering records, the
// promotion ledger, and every agent definition under `.oxagen/agents/`. A
// workspace has exactly one, and until it is bound the workspace is
// provisional: runs record and spend counts, but steering and agent
// definitions stay off.
//
// These are types rather than zod schemas, and deliberately so. Every other
// view model in this directory exists because its port maps a contract record
// into a different shape and parses the result at the boundary (§3.4);
// `get_main_repository` and `list_installation_repositories` were written for
// this surface and answer in exactly this shape, so a schema here would parse
// a record the contract's own output schema has already parsed and could never
// refuse — dead code with a `record_unmappable` branch no test could reach.
// What the app still needs is its own name for the record, so that a contract
// that drifts fails where the action returns it rather than somewhere in the
// dialog: the actions declare these types as their return, and the compiler
// does the checking the parse would have done.
//
// Only the two records an action returns are exported. The three that compose
// them — MainRepository, GitHubInstallation, InstallationRepository — stay
// local: a consumer of `WorkspaceRepository` reaches its parts through it and
// needs no separate import, and `knip --production --strict` (CI's `checks`
// job) fails an exported type nothing imports. Export one only when a caller
// actually names it.
//
// A URL is a plain string here. Narrowing it to a linkable value is
// `parseGitHubUrl` in `@/shared/github-url`, which this layer may not import
// (§2: a view model imports only other view models), so the dialog narrows it
// at render, the way the Steering page narrows a pull request URL.

type MainRepository = {
  bindingId: string;
  owner: string;
  name: string;
  /** `owner/name` as GitHub reports it; what the dialog cites. */
  fullName: string;
  /** The branch `.oxagen/` is read from unless a context branch overrides it. */
  defaultRef: string;
  htmlUrl: string;
  boundAt: string;
  /**
   * The GitHub connection behind this binding is still live. False is the
   * state a delete-then-reconnect leaves: the binding head still points at the
   * retired connection, every reader that joins the two finds nothing, and
   * steering is off while the repository still reads as bound. The panel shows
   * the repository either way and offers the repair — re-binding the same
   * repository, which supersedes the binding onto the live connection.
   */
  connectionLive: boolean;
};

type GitHubInstallation = {
  /**
   * An installation is attached to this workspace's GitHub connection. False
   * is exactly the state in which `bind_main_repository` refuses with
   * `github_not_connected`, so the dialog offers the install door instead of a
   * picker that could only refuse.
   */
  connected: boolean;
  /**
   * CONNECT: the identity leg, for an account that already carries the App
   * somewhere. Signed; always round-trips a code and our state. Null when the
   * App is unconfigured for this deployment — all three are null together.
   */
  connectUrl: string | null;
  /**
   * INSTALL: `installations/new`, signed with the same state, for an account
   * that carries the App nowhere. Distinct from `manageUrl`, which is the same
   * page with no state: that one round-tripped nothing, so a first-ever install
   * dead-ended on the app root with the workspace unconnected (#3254).
   */
  installUrl: string | null;
  /** MANAGE: reconfigure an installation that is already attached. Unsigned; it starts no flow. */
  manageUrl: string | null;
};

export type WorkspaceRepository = {
  repository: MainRepository | null;
  github: GitHubInstallation;
};

type InstallationRepository = {
  /** GitHub's numeric repository id as text; survives renames and transfers. */
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
};

export type InstallationRepositories = {
  repositories: InstallationRepository[];
  /**
   * The installation reaches more repositories than the read walked. Said out
   * loud rather than paginated: a person looking for a repository that is not
   * on the list is told to narrow the App's repository access, not left
   * scrolling for one that was silently dropped.
   */
  truncated: boolean;
};

/**
 * One GitHub App installation this workspace could act through, as
 * `list_github_installations` reports it.
 *
 * The id is here, and it is the only place in this surface an installation id
 * is. Every row came from `GET /user/installations` answered for this
 * workspace's own stored authorization — GitHub showing a person their own
 * installations — and `attach_github_installation` re-asks that same list
 * before it writes. `WorkspaceRepository` still carries no id for the
 * installation already attached, because nothing on screen needs it.
 */
type GitHubInstallationCandidate = {
  /** GitHub's numeric installation id as text; what the attach takes. */
  installationId: string;
  /** The account the App is installed on, which is what the picker cites. */
  accountLogin: string;
  /** `User` or `Organization`; null when GitHub reported none. */
  accountType: string | null;
  avatarUrl: string | null;
  /** `all` or `selected` — whether the App reaches every repository on the account. */
  repositorySelection: string | null;
};

/**
 * The installations the workspace could attach. An empty list is not a
 * refusal: it is the honest answer for an account that has authorized Oxagen
 * and installed the App nowhere, and the dialog answers it with the install
 * door rather than a picker with nothing in it.
 */
export type GitHubInstallations = {
  installations: GitHubInstallationCandidate[];
};

/** What an attach settled, so the panel can name the account it now acts through. */
export type AttachedInstallation = {
  connectionId: string;
  accountLogin: string | null;
};

/**
 * One repository the workspace binds, as `list_repositories` reports it (MC
 * spec §10.1): its one main repository, where `.oxagen/` lives, and every
 * linked one, the repositories its agents work on. The role is what the
 * Repositories section keys on: a linked row offers an unlink, the main row
 * never does, because a workspace without a main repo cannot exist and
 * `unlink_repository` refuses it regardless.
 */
type BoundRepositoryRow = {
  /** What `unlink_repository` takes. */
  bindingId: string;
  role: "main" | "linked";
  owner: string;
  name: string;
  /** `owner/name` as GitHub reported it when the binding was written. */
  fullName: string;
  /** The approved default ref the binding records, never live GitHub's. */
  defaultRef: string;
  htmlUrl: string;
  boundAt: string;
  /**
   * The GitHub connection behind this binding is still live. False is a
   * repository that silently stopped resolving, and the row says so.
   */
  connectionLive: boolean;
  /**
   * Whether GitHub can deliver this repository's events: the App's
   * installation lifecycle and the connection's state. `installed` is the
   * precondition for delivery, not a claim that an event arrived.
   */
  events:
    | "installed"
    | "suspended"
    | "uninstalled"
    | "paused"
    | "retired"
    | "unknown";
};

/**
 * Every repository the workspace binds, main first, linked ones after by full
 * name. A local read: nothing here came from GitHub, so the list draws while
 * GitHub is down. An empty list is a workspace that binds nothing yet, which
 * the org's first workspace is until its provisional window is closed.
 */
export type WorkspaceRepositories = {
  repositories: BoundRepositoryRow[];
};

/** What a link settled, so the section can name the repository it now binds. */
export type LinkedRepository = {
  bindingId: string;
  fullName: string;
  defaultRef: string;
  linkedAt: string;
};

/** What an unlink settled: the repository that left the workspace's view. */
export type UnlinkedRepository = {
  bindingId: string;
  fullName: string;
  unlinkedAt: string;
};

/** The governance mode `.oxagen/rules/governance.toml` declares, as read. */
export type DeclaredGovernanceMode =
  | "solo"
  | "team"
  | "regulated"
  | "absent"
  | "invalid";

/**
 * What one bound repository holds under `.oxagen/` on its production branch,
 * as `get_repository_tree` read it from GitHub at `readAt`. `head` is null
 * when the production branch no longer exists on GitHub: a fact the page
 * shows, with the repair beside it.
 */
export type RepositoryTree = {
  bindingId: string;
  role: "main" | "linked";
  fullName: string;
  productionBranch: string;
  /** GitHub's default branch now: the suggestion, never the decision. */
  githubDefaultBranch: string;
  head: string | null;
  oxagen: { present: boolean; files: string[] };
  workspaceToml: string | null;
  governanceToml: string | null;
  governanceMode: DeclaredGovernanceMode;
  initPullRequest: { number: number; htmlUrl: string } | null;
  readAt: string;
};

/** What `set_production_branch` settled. */
export type ProductionBranchSet = {
  bindingId: string;
  fullName: string;
  productionBranch: string;
  previousBranch: string;
  changed: boolean;
};

/** What `open_init_pr` settled: the pull request that adds `.oxagen/`. */
export type InitPullRequest = {
  fullName: string;
  branch: string;
  base: string;
  pullRequest: { number: number; htmlUrl: string };
  files: string[];
  reused: boolean;
};

/**
 * One pull request Oxagen has open or has had merged, as the Changes tab
 * lists it. Today every row is a context record's Context PR
 * (`list_proposals`): the other kinds the mockup names (init, skill, agent,
 * tool, configuration) have no list read yet, and the tab says so.
 */
export type RepositoryChange = {
  proposalId: string;
  /** The record's lineage: the file stem under `.oxagen/rules/`, and the row's title. */
  lineage: string;
  statement: string;
  /** Why it was proposed, as the proposal recorded it. */
  why: string;
  kind: "context_record";
  pullRequest: {
    number: number;
    url: string;
    repository: string;
    branch: string;
  };
  /** Who opened it, as the proposal recorded its source. */
  openedBy: string;
  status:
    | "pr_open"
    | "checks_running"
    | "checks_passed"
    | "checks_failed"
    | "merged"
    | "rejected";
  checks: { passed: number; total: number } | null;
  openedAt: string;
};

export type RepositoryChanges = {
  changes: RepositoryChange[];
  /** Pull requests still waiting on a person: every state but merged and rejected. */
  open: number;
};
