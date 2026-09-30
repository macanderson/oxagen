// repository.tree.get.ts — `get_repository_tree` (Mission Control spec §10.1,
// §10.2; the Repositories page).
//
// Flow:
//   1. The bound repository by its binding id, in this workspace
//      (`not_found: repository_not_linked`).
//   2. A client for the workspace's installation
//      (`conflict: github_not_connected`). A steering repository on a
//      `github_steering` connection reads through the Oxagen GitHub App.
//   3. The repository as GitHub reports it now, for its default branch; one
//      the installation cannot see, and one whose immutable id is no longer
//      the bound one, are both `not_found: repository_not_installed`.
//   4. The production branch's head. A branch GitHub no longer has answers
//      `head: null` and an empty tree rather than a refusal: it is a fact the
//      page must show, and the repair (`set_production_branch`) is on the
//      same page.
//   5. The paths under `.oxagen/` and `steering/` at that head, the two files
//      the page shows in full when they exist, the mode the governance file
//      declares (read by the same parser the Context PR gate uses), and the
//      open init pull request. A steering repository keeps its mode in
//      `steering/governance.toml`, and a legacy one in
//      `.oxagen/rules/governance.toml` (#4821).
//
// No store is written. Every fact here is GitHub's, read at call time.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  repositoryTreeGet,
  type RepositoryTreeGetOutput,
} from "@oxagen/oxagen/contracts/repository.tree.get";
import { INIT_BRANCH } from "@oxagen/oxagen/contracts/repository.init_pr.open";
import {
  GOVERNANCE_TOML_PATH,
  LEGACY_OXAGEN_DIR,
  LEGACY_WORKSPACE_TOML_PATH,
  STEERING_DIR,
} from "@oxagen/oxagen/steering-repo/paths";
import {
  GOVERNANCE_PATH,
  parseGovernanceMode,
} from "./context.steering.policy";
import {
  readBoundRepository,
  requireBoundRepoInfo,
  requireWorkspaceGithub,
  workspaceGithub,
  type WorkspaceGithub,
} from "./repository.bound";

export const OXAGEN_DIR = `${LEGACY_OXAGEN_DIR}/`;
const STEERING_PREFIX = `${STEERING_DIR}/`;
export const WORKSPACE_TOML_PATH = LEGACY_WORKSPACE_TOML_PATH;

export interface RepositoryTreeDeps {
  github: WorkspaceGithub;
  readBound: typeof readBoundRepository;
  now: () => Date;
}

/** The mode a governance.toml's text declares, in the contract's words. */
export function declaredMode(
  text: string | null,
): RepositoryTreeGetOutput["governanceMode"] {
  if (text === null) return "absent";
  const mode = parseGovernanceMode(text);
  return typeof mode === "string" ? mode : "invalid";
}

export function createRepositoryTreeGetHandler(
  deps: RepositoryTreeDeps,
): CapabilityHandler<typeof repositoryTreeGet> {
  return async (input, ctx): Promise<RepositoryTreeGetOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const bound = await deps.readBound(scope, input.bindingId);
    const gh = await requireWorkspaceGithub(
      deps.github,
      scope,
      bound.connectionId,
    );
    const at = { owner: bound.owner, repo: bound.name };

    // The repository GitHub holds at these coordinates, and that it is still
    // the one this binding was made against: a repository deleted and
    // re-created under the same owner/name would otherwise be reported, with
    // its branch and its files, under this workspace's binding.
    const githubDefaultBranch = (await requireBoundRepoInfo(gh, bound))
      .defaultBranch;

    const branch = await gh.getBranch({
      ...at,
      branch: bound.productionBranch,
    });
    const head = branch?.sha ?? null;

    let files: string[] = [];
    let steeringFiles: string[] = [];
    let workspaceToml: string | null = null;
    let governanceToml: string | null = null;
    let governancePath: string = GOVERNANCE_PATH;
    if (head !== null) {
      // Every read below names the commit, not the branch. A push that lands
      // between two reads would otherwise mix two commits into one answer,
      // and the page says the files are "at commit <head>".
      const tree = await gh.getTree({ ...at, ref: head });
      files = tree.filter((path) => path.startsWith(OXAGEN_DIR)).sort();
      steeringFiles = tree
        .filter((path) => path.startsWith(STEERING_PREFIX))
        .sort();
      // A steering repository keeps its mode in steering/governance.toml.
      // Conversion deletes the legacy file, so reading it there would report
      // the default mode, not the one in force.
      const steering = steeringFiles.includes(GOVERNANCE_TOML_PATH);
      if (steering) governancePath = GOVERNANCE_TOML_PATH;
      const governanceListed = steering || files.includes(GOVERNANCE_PATH);
      // Read only what the tree says is there: two GETs that would 404 are
      // two round trips a person waits for and learns nothing from.
      const [workspace, governance] = await Promise.all([
        files.includes(WORKSPACE_TOML_PATH)
          ? gh.getFileContent({
              ...at,
              path: WORKSPACE_TOML_PATH,
              ref: head,
            })
          : null,
        governanceListed
          ? gh.getFileContent({
              ...at,
              path: governancePath,
              ref: head,
            })
          : null,
      ]);
      workspaceToml = workspace;
      governanceToml = governance;
    }

    const pr = await gh.findOpenPullRequest({
      ...at,
      head: INIT_BRANCH,
      base: bound.productionBranch,
    });

    return {
      bindingId: bound.bindingId,
      role: bound.role,
      fullName: bound.fullName,
      productionBranch: bound.productionBranch,
      githubDefaultBranch,
      head,
      oxagen: { present: files.length > 0, files },
      steering: { present: steeringFiles.length > 0, files: steeringFiles },
      workspaceToml,
      governancePath,
      governanceToml,
      governanceMode: declaredMode(governanceToml),
      initPullRequest: pr ? { number: pr.number, htmlUrl: pr.htmlUrl } : null,
      readAt: deps.now().toISOString(),
    };
  };
}

export const repositoryTreeGetHandler = createRepositoryTreeGetHandler({
  github: workspaceGithub,
  readBound: readBoundRepository,
  now: () => new Date(),
});
