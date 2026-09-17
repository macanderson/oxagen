// The Workspace settings dialog's view models (MC spec §10.1–§10.2): the
// workspace's main repository, whether a GitHub App installation is attached,
// and the set of repositories that installation reaches.
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
// A URL is a plain string here. Narrowing it to a linkable value is
// `parseGitHubUrl` in `@/shared/github-url`, which this layer may not import
// (§2: a view model imports only other view models), so the dialog narrows it
// at render, the way the Steering page narrows a pull request URL.

export type MainRepository = {
  bindingId: string;
  owner: string;
  name: string;
  /** `owner/name` as GitHub reports it; what the dialog cites. */
  fullName: string;
  /** The branch `.oxagen/` is read from unless a context branch overrides it. */
  defaultRef: string;
  htmlUrl: string;
  boundAt: string;
};

export type GitHubInstallation = {
  /**
   * An installation is attached to this workspace's GitHub connection. False
   * is exactly the state in which `bind_main_repository` refuses with
   * `github_not_connected`, so the dialog offers the install door instead of a
   * picker that could only refuse.
   */
  connected: boolean;
  /** Install the App against this workspace; null when the App is unconfigured for this deployment. */
  installUrl: string | null;
  /** Change which repositories the existing installation reaches; null when the App is unconfigured. */
  manageUrl: string | null;
};

export type WorkspaceRepository = {
  repository: MainRepository | null;
  github: GitHubInstallation;
};

export type InstallationRepository = {
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
