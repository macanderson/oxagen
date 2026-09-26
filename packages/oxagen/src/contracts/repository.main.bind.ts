/**
 * `bind_main_repository`: bind a GitHub repository as this workspace's main
 * repo (MC spec App. F "Bind <repo> as the main repo (installs the GitHub
 * App: binding, Context PRs, checks …)"; #2967).
 *
 * The GitHub App installation reaches the workspace through the connect
 * flow the API already runs (`/connections/github/auth-url` → GitHub → the
 * HMAC-verified callback), which attaches the installation id to the
 * workspace's GitHub connection. This write names only the repository: the
 * handler takes the installation from that connection — never from the
 * caller, because an installation id a caller could choose would let one
 * tenant mint tokens for another account's installation — reads the
 * repository through the installation's token (a repository the
 * installation cannot see is `not_found: repository_not_installed`), and
 * writes, in one transaction, the version-1 repository binding and its head
 * (`ingestion.repository_bindings` / `repository_binding_heads`, the rows
 * the run ledger pins), marks the
 * connection connected (the row `resolveGitHubToken` mints from), and closes
 * the onboarding gate's provisional window when the workspace is the gate's.
 * Binding the same repository again is idempotent **while nothing it recorded
 * has moved**: the existing binding's identity is answered and nothing is
 * written. When any recorded fact differs from what GitHub now reports — the
 * connection, the owner, the name, the full name, or the approved default ref
 * — the call is a RE-APPROVAL and writes a successor binding (version + 1,
 * naming the one it supersedes) with the head moved onto it. That is what a
 * binding version means (`ingestion.repository_bindings`: "a rename or a
 * reconfigured default ref"), and it is the only way the approved production
 * ref ever changes, because steering reads the ref from the binding and never
 * from live GitHub. Which repository is main never moves here: a workspace
 * that already binds a different repository is `conflict: main_repo_bound`; a
 * workspace with no GitHub installation attached is
 * `conflict: github_not_connected`. A repository another workspace holds is
 * refused across tenants (ADR-099): `conflict: main_repo_claimed` when it is
 * that workspace's main, `conflict: repository_linked_elsewhere` when that
 * workspace has linked it. The store's trigger
 * `repository_binding_heads_exclusive_main` holds both under a
 * repository-keyed lock, so a lost race is refused with the same reasons.
 *
 * GitLab (#3762): `{ provider: "gitlab", projectPath }` binds a gitlab.com
 * project the workspace connected with `attach_gitlab_project`. The project is
 * read by id through that connection's project access token, and the binding
 * and head carry `provider = 'gitlab'`, so a GitLab project id never collides
 * with a GitHub repository id. With no such connection the call is
 * `conflict: gitlab_not_connected`. The same idempotency, re-approval and
 * cross-workspace refusals apply.
 *
 * Roles: org Owner or Admin, checked by the handler (INV-29), so the caller
 * is a signed-in user: the API surface only. The MCP context carries an API
 * key and no user, and `assertOrgRole` refuses it before any read. A
 * settings write: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { gitlabProjectPathSchema } from "./repository.gitlab.attach";

/** A GitHub account login, as GitHub constrains it. */
export const githubOwnerSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/);

/** A GitHub repository name, as GitHub constrains it. */
export const githubRepositoryNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/);

export const repositoryMainBind = registerCapability({
  name: "bind_main_repository",
  domain: "repository",
  description:
    "Bind the workspace's main repository and close the onboarding gate's provisional window: a GitHub repository the workspace's GitHub App installation reaches, or a gitlab.com project connected with attach_gitlab_project.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.union([
    z
      .object({
        /** Omitted by every caller that predates GitLab: GitHub is the default. */
        provider: z.literal("github").optional(),
        owner: githubOwnerSchema,
        name: githubRepositoryNameSchema,
      })
      .strict(),
    z
      .object({
        provider: z.literal("gitlab"),
        /**
         * `group/sub/project` on gitlab.com, connected first with
         * `attach_gitlab_project`. The binding pins the project's numeric id,
         * so a later move to another group keeps the binding.
         */
        projectPath: gitlabProjectPathSchema,
      })
      .strict(),
  ]),
  output: z
    .object({
      bindingId: z.string().regex(/^rpb_[0-9a-f]+$/),
      connectionId: z.string().regex(/^con_[0-9a-z]+$/),
      /** Which host the main repository is on. */
      provider: z.enum(["github", "gitlab"]),
      /** `owner/name` (GitHub) or `group/sub/project` (GitLab) as the host reports it. */
      fullName: z.string().min(1),
      defaultRef: z.string().min(1),
      boundAt: z.string().datetime({ offset: true }),
      /** True when this call closed the onboarding gate's provisional window. */
      provisionalClosed: z.boolean(),
    })
    .strict(),
});

export type RepositoryMainBindInput = z.output<typeof repositoryMainBind.input>;
export type RepositoryMainBindOutput = z.output<
  typeof repositoryMainBind.output
>;
