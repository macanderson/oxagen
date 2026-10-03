/**
 * `link_repository`: propose linking a GitHub repository to the workspace
 * (ADR-212).
 *
 * A workspace has one steering repository and any number of linked code
 * repositories. The steering record decides which repositories are linked:
 * `workspace.toml` lists each one as a `[[repositories]]` entry. This write
 * opens a steering PR that adds the entry. The link itself follows the
 * merge. The steering sync reads `workspace.toml` at the new head and writes
 * the repository's binding and its `role = 'linked'` head.
 *
 * It names only the repository. The installation is the one attached to the
 * workspace's GitHub connection, never the caller's choice. An installation id
 * a caller could choose would let one tenant mint tokens for another account's
 * installation. The handler reads the repository through that installation's
 * token. A repository it cannot see is `not_found: repository_not_installed`.
 *
 * `status` says what happened:
 *   - `proposed`: a steering PR adds the entry. `reused` is true when that PR
 *     was already open.
 *   - `listed`: `workspace.toml` on the production branch already lists the
 *     repository, so no PR is needed. The next steering sync writes the link.
 *
 * Refusals:
 *   - `conflict: github_not_connected`: no installation is attached.
 *   - `conflict: main_repo_unbound`: the workspace has no steering repository
 *     to hold the steering record.
 *   - `conflict: main_repo`: it is this workspace's steering repository.
 *   - `conflict: repository_already_linked`: it is linked already.
 *   - `conflict: workspace_toml_unreadable`: the steering repository's
 *     `workspace.toml` is present but does not read as `workspace/v1`. When
 *     the file is missing, the steering PR creates it.
 *
 * Another workspace's heads refuse nothing (ADR-293). Any number of
 * workspaces may link one repository, and that includes a repository another
 * workspace steers by. The one exclusive rule belongs to the agent: it is
 * steered by one steering repository, which its workspace picks.
 *
 * The reason codes keep their `main_repo` spelling so existing callers still
 * match them. Their messages say "steering repository".
 *
 * Roles: org Owner or Admin, or the workspace's Owner, checked by the handler
 * (INV-29). A settings write: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  githubOwnerSchema,
  githubRepositoryNameSchema,
} from "./repository.shared";

/** The steering PR a link or an unlink opened on the steering repository. */
export const steeringPullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string().url(),
    /** True when a steering PR for the same change was already open. */
    reused: z.boolean(),
  })
  .strict();

export type SteeringPullRequest = z.output<typeof steeringPullRequestSchema>;

export const repositoryLink = registerCapability({
  name: "link_repository",
  domain: "repository",
  description:
    "Open a steering PR that links a GitHub repository to the workspace. The link takes effect when the PR merges.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  agent: { requiresApproval: true, riskLevel: "medium", category: "vcs" },
  input: z
    .object({
      provider: z.literal("github").default("github"),
      owner: githubOwnerSchema,
      name: githubRepositoryNameSchema,
    })
    .strict(),
  output: z
    .object({
      /** `owner/name` as GitHub reports it. */
      fullName: z.string().min(1),
      defaultRef: z.string().min(1),
      status: z.enum(["proposed", "listed"]),
      /** The steering PR that adds the repository, or null when `status` is `listed`. */
      steeringPullRequest: steeringPullRequestSchema.nullable(),
    })
    .strict(),
});

export type RepositoryLinkInput = z.output<typeof repositoryLink.input>;
export type RepositoryLinkOutput = z.output<typeof repositoryLink.output>;
