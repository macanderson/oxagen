import { z } from "zod";
import { registerCapability } from "../registry";
import { workspaceSlug } from "../workspace-slug";
import {
  gitlabProjectPathSchema,
  gitlabTokenSchema,
} from "./repository.gitlab.attach";
import {
  githubOwnerSchema,
  githubRepositoryNameSchema,
  repositoryMainBind,
} from "./repository.main.bind";

/**
 * A GitHub main repository by owner and name. Exported for the MCP tool, which
 * offers only this arm: the GitLab arm carries a token, and a token must not
 * travel through an agent's or an MCP client's transcript.
 */
export const githubMainRepoInput = z
  .object({
    provider: z.literal("github").default("github"),
    owner: githubOwnerSchema,
    name: githubRepositoryNameSchema,
  })
  .strict();

/**
 * A gitlab.com main project and a project access token for it (#3762). The
 * workspace does not exist yet, so it has no connection to hold a token, and
 * the token arrives with the request. The handler accepts this arm on the API
 * surface only.
 */
export const gitlabMainRepoInput = z
  .object({
    provider: z.literal("gitlab"),
    projectPath: gitlabProjectPathSchema,
    token: gitlabTokenSchema,
  })
  .strict();

/**
 * create_workspace — a workspace in the caller's org, with its main repository.
 *
 * Mission Control spec §10.1 and the §17 M0 acceptance test: a workspace
 * cannot exist without a main repo. So `mainRepo` is required, and the handler
 * writes the workspace, its GitHub connection, the version-1 repository
 * binding and its `role = 'main'` head in ONE transaction — a creation that
 * cannot bind writes nothing (ADR-099).
 *
 * The caller names the repository, never an installation. The installation is
 * the one the org's stored GitHub authorization reaches on the repository's
 * owner account (`GET /user/installations`), the same reachability rule
 * `attach_github_installation` applies, because an installation id a caller
 * could choose would let one tenant mint tokens for another account's
 * installation. Refusals: `conflict: github_not_authorized` (the org has no
 * usable GitHub authorization), `not_found: installation_unreachable` (the App
 * is not installed on that owner, or the authorization cannot reach it),
 * `not_found: repository_not_installed` (the installation cannot see the
 * repository), `conflict: main_repo_claimed` (another workspace already
 * steers by it), `conflict: repository_linked_elsewhere` (another workspace
 * has linked it, and a repository that receives one workspace's Context PRs
 * cannot hold another's `.oxagen/` governance tree), `conflict: slug_taken`.
 * The two repository refusals are held by the store as well as by the
 * handler's pre-check: the trigger `repository_binding_heads_exclusive_main`
 * refuses a lost race with the same reasons.
 *
 * GitLab (#3762): `mainRepo: { provider: "gitlab", projectPath, token }`
 * creates the workspace with a gitlab.com main project and no GitHub
 * installation. The token is verified exactly as `attach_gitlab_project`
 * verifies it (a live project access token for that project, with the `api`
 * scope) and stored encrypted with the new workspace's GitLab connection.
 * Accepted on the API surface only: `conflict: gitlab_token_surface` for any
 * other surface.
 *
 * The production branch is GitHub's default branch, recorded as the binding's
 * configured default ref exactly as `bind_main_repository` records it; a
 * re-approval there is how it later moves.
 *
 * Org Owners and Admins, and a workspace Owner calling from a workspace, are
 * checked in the handler (INV-29).
 */
export const workspaceCreate = registerCapability({
  name: "create_workspace",
  domain: "workspace",
  description:
    "Create a workspace within the active tenant together with its main repository, which is required: a GitHub repository, or a gitlab.com project with a project access token (API only). Refused for a slug already used in the organization, or a repository the org's GitHub App installation cannot reach or another workspace already steers by.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  // A settings write, never a governed action (ADR-052 exclusion 2; INV-28).
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "low", category: "workspace" },
  sensitivity: "medium",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    name: z.string().min(1).max(120),
    // The shared shape (packages/oxagen/src/workspace-slug.ts): reserved
    // org-route segments are refused, and the spelling is the one
    // `update_workspace_settings` also takes, so a workspace this creates can
    // always be edited afterwards (#3110).
    slug: workspaceSlug,
    // Required: §17 M0, "a workspace cannot be created without a main repo".
    // Owner and name carry `bind_main_repository`'s GitHub-shaped validation
    // by import, so the two doors to a main repository refuse the same names.
    mainRepo: z.union([githubMainRepoInput, gitlabMainRepoInput]),
  }),
  output: z.object({
    publicId: z.string(),
    name: z.string(),
    slug: z.string(),
    orgSlug: z.string(),
    createdAt: z.string(),
    mainRepo: z.object({
      bindingId: repositoryMainBind.output.shape.bindingId,
      connectionId: repositoryMainBind.output.shape.connectionId,
      /** The host the main repository is on. */
      provider: z.enum(["github", "gitlab"]),
      /** `owner/name` (GitHub) or `group/sub/project` (GitLab). */
      fullName: z.string().min(1),
      /** The approved production ref: the host's default branch at creation. */
      defaultRef: z.string().min(1),
    }),
  }),
});

export type WorkspaceCreateInput = z.output<typeof workspaceCreate.input>;
export type WorkspaceCreateOutput = z.output<typeof workspaceCreate.output>;
