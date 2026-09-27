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
} from "./repository.main.bind";

/**
 * A GitHub repository by owner and name, the older `mainRepo` shape. The
 * handler ignores it (see `workspaceCreate`). The MCP tool still offers only
 * this arm, because the GitLab arm carries a token, and a token must not
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
 * A gitlab.com project and a project access token for it (#3762), the older
 * GitLab `mainRepo` shape. The handler ignores it (see `workspaceCreate`).
 */
export const gitlabMainRepoInput = z
  .object({
    provider: z.literal("gitlab"),
    projectPath: gitlabProjectPathSchema,
    token: gitlabTokenSchema,
  })
  .strict();

/**
 * Where a workspace's steering repo stands. `provisioning` means the job is
 * still running, `ready` means the repository exists and is bound, `failed`
 * means a step stopped and a retry resumes from it, and `blocked` means an
 * organization owner must act first, such as authorizing Oxagen again.
 */
export const steeringRepoProvisionStatus = z.enum([
  "provisioning",
  "ready",
  "failed",
  "blocked",
]);

export type SteeringRepoProvisionStatus = z.output<
  typeof steeringRepoProvisionStatus
>;

/**
 * create_workspace: a workspace in the caller's org, and the start of its
 * steering repo (steering-repo-spec, Provisioning; lane S1, #4450).
 *
 * The handler records the workspace and the first state of its
 * `steering_repo` setting, then starts a durable job and returns. The job
 * creates the private repository `oxagen-<slug>` in the organization's GitHub
 * organization or GitLab group, seeds it, applies the prescribed settings,
 * publishes version 1, and binds it with role steering. The call returns
 * before the repository exists, so read the workspace's `steering_repo`
 * status to follow it. When the job cannot start, the workspace still exists
 * and the status reads `failed`.
 *
 * A workspace no longer needs a main repository. `mainRepo` is deprecated:
 * the handler accepts it so older callers keep working, logs a warning, and
 * binds nothing. Link a code repository afterwards with `link_repository`.
 *
 * Refusal: `conflict: slug_taken` when the organization already has a
 * workspace with that slug.
 *
 * Org Owners and Admins, and a workspace Owner calling from a workspace, are
 * checked in the handler (INV-29).
 */
export const workspaceCreate = registerCapability({
  name: "create_workspace",
  domain: "workspace",
  description:
    "Create a workspace within the active tenant and start provisioning its private steering repo, oxagen-<slug>, in the organization's GitHub organization or GitLab group. The call returns before the repository exists, and the workspace's steering_repo status shows the progress. You no longer pass a main repository: mainRepo is deprecated and ignored. Refused when the organization already has a workspace with that slug.",
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
    // Deprecated and ignored. The handler logs a warning and binds nothing.
    // The shape still validates, so an older caller that sends a malformed
    // repository gets the same refusal it always got.
    mainRepo: z.union([githubMainRepoInput, gitlabMainRepoInput]).optional(),
  }),
  output: z.object({
    publicId: z.string(),
    name: z.string(),
    slug: z.string(),
    orgSlug: z.string(),
    createdAt: z.string(),
    /** The steering repo's provisioning status when the call returned. */
    steering_repo: z.object({ status: steeringRepoProvisionStatus }),
  }),
});

export type WorkspaceCreateInput = z.output<typeof workspaceCreate.input>;
export type WorkspaceCreateOutput = z.output<typeof workspaceCreate.output>;
