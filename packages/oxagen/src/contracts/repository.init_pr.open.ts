/**
 * `open_init_pr`: add Oxagen to one of the workspace's repositories by opening
 * a pull request that puts the `.oxagen/` tree there (Mission Control spec
 * §10.2; the init wizard on the Repositories page).
 *
 * It is the only write that can run against a repository Oxagen has never
 * written to, and it still writes only to a branch: `oxagen/init`, from the
 * production branch, with one pull request back into it. Nothing reaches the
 * production branch until a person merges that pull request on GitHub.
 *
 * The pull request carries five files: `.oxagen/workspace.toml` and
 * `.oxagen/rules/governance.toml` as the caller reviewed them, `.gitkeep`
 * files that hold `.oxagen/rules/` and `.oxagen/proposals/`, and
 * `.gitignore` with the machine-local
 * `.oxagen/workspace.json` and `.stella/private/` added when missing.
 * `governance.toml` is the one file nothing else in the product writes, so its
 * text is checked before anything is pushed: it must parse and declare exactly
 * the mode the caller chose.
 *
 * Idempotent: an init pull request already open for the repository is
 * answered as it is (`reused: true`) and nothing is pushed.
 *
 * Refusals: `not_found: repository_not_linked`, `conflict: github_not_connected`,
 * `not_found: repository_not_installed`, `conflict: production_branch_missing`
 * (the branch the binding records is gone from GitHub),
 * `conflict: production_branch_is_init_branch` (the production branch is
 * `oxagen/init`, so pushing there would write to the production branch),
 * `conflict: oxagen_tree_exists` (the repository already has `.oxagen/`;
 * changing it is an ordinary pull request), `conflict: governance_toml_invalid`
 * and `conflict: workspace_toml_invalid`, and `conflict: github_refused` with
 * GitHub's own message when a push is refused.
 *
 * Roles: org Owner or Admin (repository-binding spec section 2.3).
 * A settings write: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { governanceModeSchema } from "./context.steering.shared";
import { repositoryMainBind } from "./repository.main.bind";

/** The branch every init pull request is opened from. */
export const INIT_BRANCH = "oxagen/init";

export const repositoryInitPrOpen = registerCapability({
  name: "open_init_pr",
  domain: "repository",
  description:
    "Add Oxagen to one of the workspace's repositories: open a pull request from oxagen/init that adds the .oxagen/ tree with the reviewed workspace.toml and governance.toml. Never writes to the production branch.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      bindingId: repositoryMainBind.output.shape.bindingId,
      governanceMode: governanceModeSchema,
      /** `.oxagen/workspace.toml` as the person reviewed it. */
      workspaceToml: z.string().min(1).max(64_000),
      /** `.oxagen/rules/governance.toml` as the person reviewed it. */
      governanceToml: z.string().min(1).max(16_000),
    })
    .strict(),
  output: z
    .object({
      bindingId: repositoryMainBind.output.shape.bindingId,
      fullName: z.string().min(1),
      branch: z.literal(INIT_BRANCH),
      base: z.string().min(1),
      pullRequest: z
        .object({
          number: z.number().int().positive(),
          htmlUrl: z.string().url(),
        })
        .strict(),
      /** Every path the pull request carries. Empty when `reused`. */
      files: z.array(z.string().min(1)),
      reused: z.boolean(),
      openedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
});

export type RepositoryInitPrOpenInput = z.output<
  typeof repositoryInitPrOpen.input
>;
export type RepositoryInitPrOpenOutput = z.output<
  typeof repositoryInitPrOpen.output
>;
