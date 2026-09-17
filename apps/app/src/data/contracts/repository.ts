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
// Every external URL is narrowed to a `GitHubUrl` here rather than in the
// component, so a value the parser will not vouch for arrives as null and the
// dialog says what is missing instead of rendering a dead control (INV-13:
// `ui/navigation.tsx` owns the one anchor that opens it).
import { z } from "zod";
import { parseGitHubUrl } from "@/shared/github-url";

const Instant = z.iso.datetime({ offset: true });

/** An https URL on github.com, or null when the value is not one. */
const GitHubHref = z
  .string()
  .nullable()
  .transform((raw) => parseGitHubUrl(raw));

export const MainRepository = z.object({
  bindingId: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  /** `owner/name` as GitHub reports it; what the dialog cites. */
  fullName: z.string().min(1),
  /** The branch `.oxagen/` is read from unless a context branch overrides it. */
  defaultRef: z.string().min(1),
  htmlUrl: GitHubHref,
  boundAt: Instant,
});
export type MainRepository = z.infer<typeof MainRepository>;

export const GitHubInstallation = z.object({
  /**
   * An installation is attached to this workspace's GitHub connection. False
   * is exactly the state in which `bind_main_repository` refuses with
   * `github_not_connected`, so the dialog offers the install door instead of
   * a picker that could only refuse.
   */
  connected: z.boolean(),
  /** Install the App against this workspace; null when the App is unconfigured for this deployment. */
  installUrl: GitHubHref,
  /** Change which repositories the existing installation reaches; null when the App is unconfigured. */
  manageUrl: GitHubHref,
});
export type GitHubInstallation = z.infer<typeof GitHubInstallation>;

export const WorkspaceRepository = z.object({
  repository: MainRepository.nullable(),
  github: GitHubInstallation,
});
export type WorkspaceRepository = z.infer<typeof WorkspaceRepository>;

export const InstallationRepository = z.object({
  /** GitHub's numeric repository id as text; survives renames and transfers. */
  id: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  fullName: z.string().min(1),
  defaultBranch: z.string().min(1),
  private: z.boolean(),
  htmlUrl: GitHubHref,
});
export type InstallationRepository = z.infer<typeof InstallationRepository>;

export const InstallationRepositories = z.object({
  repositories: z.array(InstallationRepository),
  /**
   * The installation reaches more repositories than the read walked. Said out
   * loud rather than paginated: a person looking for a repository that is not
   * on the list is told to narrow the App's repository access, not left
   * scrolling for one that was silently dropped.
   */
  truncated: z.boolean(),
});
export type InstallationRepositories = z.infer<typeof InstallationRepositories>;
