/**
 * `get_repository_tree`: what one of the workspace's repositories holds under
 * `.oxagen/` on its production branch (Mission Control spec §10.1, §10.2), for
 * the Repositories page, the CLI and MCP.
 *
 * The answer is read from GitHub through the workspace's own App installation
 * at the moment of the call, never from a copy: git decides what is in force,
 * so a page that described `.oxagen/` from a cache would be describing the
 * past. It carries:
 *
 * - the production branch the binding records and the commit it points at now
 *   (`head` is null when that branch no longer exists on GitHub);
 * - GitHub's current default branch, so a caller can see that it moved without
 *   the binding moving (§11.4: the binding never moves on its own);
 * - whether the tree exists, and every path under it;
 * - the text of `.oxagen/workspace.toml` and `.oxagen/rules/governance.toml`,
 *   and the governance mode the second declares (`absent` when there is no
 *   file, which the Context PR gate reads as `team`; `invalid` when the file
 *   names no mode it knows, which the gate refuses);
 * - the open pull request `open_init_pr` left, if one is waiting.
 *
 * Refusals: `not_found: repository_not_linked` (no head in this workspace
 * carries the binding) and `conflict: github_not_connected` (no installation
 * to read through). A read: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { repositoryMainBind } from "./repository.main.bind";
import { repositoryRole } from "./repository.list";

/** The governance mode `.oxagen/rules/governance.toml` declares, as read. */
export const declaredGovernanceMode = z.enum([
  "solo",
  "team",
  "regulated",
  "absent",
  "invalid",
]);

export const repositoryTreeGet = registerCapability({
  name: "get_repository_tree",
  domain: "repository",
  description:
    "Read what one of the workspace's repositories holds under .oxagen/ on its production branch: the head commit, every path, workspace.toml, governance.toml and its mode, and any open init pull request.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      bindingId: repositoryMainBind.output.shape.bindingId,
    })
    .strict(),
  output: z
    .object({
      bindingId: repositoryMainBind.output.shape.bindingId,
      role: repositoryRole,
      /** `owner/name` as the binding recorded it. */
      fullName: z.string().min(1),
      /** The branch the binding records: the only one `.oxagen/` is read from. */
      productionBranch: z.string().min(1),
      /** GitHub's default branch right now; a suggestion, never the decision. */
      githubDefaultBranch: z.string().min(1),
      /** The production branch's head commit; null when the branch is gone. */
      head: z.string().nullable(),
      oxagen: z
        .object({
          present: z.boolean(),
          /** Every path under `.oxagen/`, sorted, at `head`. */
          files: z.array(z.string().min(1)),
        })
        .strict(),
      workspaceToml: z.string().nullable(),
      governanceToml: z.string().nullable(),
      governanceMode: declaredGovernanceMode,
      /** The open pull request that adds `.oxagen/`, when one is waiting. */
      initPullRequest: z
        .object({
          number: z.number().int().positive(),
          htmlUrl: z.string().url(),
        })
        .strict()
        .nullable(),
      readAt: z.string().datetime({ offset: true }),
    })
    .strict(),
});

export type RepositoryTreeGetInput = z.output<typeof repositoryTreeGet.input>;
export type RepositoryTreeGetOutput = z.output<typeof repositoryTreeGet.output>;
