/**
 * `link_repository`: link a GitHub repository to the workspace as a LINKED
 * repository (Mission Control spec §10.1; the §17 M0 acceptance test "a second
 * repo can be linked and unlinked").
 *
 * A workspace has exactly one main repository — the one whose `.oxagen/`
 * steers it, bound at creation (`create_workspace`) — and any number of linked
 * ones: the repositories its agents work on. This write adds one of the latter.
 * It names only the repository. The installation is the one attached to the
 * workspace's GitHub connection, never the caller's choice, for the reason
 * `bind_main_repository` gives: an installation id a caller could choose would
 * let one tenant mint tokens for another account's installation. The handler
 * reads the repository through that installation's token (a repository it
 * cannot see is `not_found: repository_not_installed`) and writes, in one
 * transaction, a repository binding and a `role = 'linked'` binding head.
 *
 * Refusals: `conflict: github_not_connected` (no installation attached),
 * `conflict: main_repo_unbound` (this workspace has no main repository yet:
 * a linked repository is its second, and the organisation's first workspace
 * is written without a main until `bind_main_repository` runs),
 * `conflict: main_repo` (it is this workspace's main repository),
 * `conflict: repository_already_linked`, and `conflict: main_repo_claimed` —
 * it is ANOTHER workspace's main repository. That last one is deliberate
 * (ADR-099): §10.1 opens repository-scoped Context PRs on the linked repository
 * itself, so linking another workspace's main repository would hand this
 * workspace a door into that workspace's `.oxagen/` governance tree. A
 * repository that is nobody's main may be linked by any number of workspaces.
 * The store holds the rule too: the trigger
 * `repository_binding_heads_exclusive_main` serialises this write against a
 * concurrent main claim on the same repository, and a lost race is answered
 * as `main_repo_claimed` as well.
 *
 * The §11.4 follow-through (event subscription, issue import, code-graph
 * index) is not part of this write; the v2 descriptor
 * (`./v2/link-repository.ts`) carries that target shape until its cutover.
 *
 * Roles: org Owner or Admin, or the workspace's Owner, checked by the handler
 * (INV-29). A settings write: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  githubOwnerSchema,
  githubRepositoryNameSchema,
  repositoryMainBind,
} from "./repository.main.bind";

export const repositoryLink = registerCapability({
  name: "link_repository",
  domain: "repository",
  description:
    "Link a GitHub repository the workspace's GitHub App installation reaches as a linked (not main) repository of the workspace.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
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
  input: z
    .object({
      provider: z.literal("github").default("github"),
      owner: githubOwnerSchema,
      name: githubRepositoryNameSchema,
    })
    .strict(),
  output: z
    .object({
      bindingId: repositoryMainBind.output.shape.bindingId,
      connectionId: repositoryMainBind.output.shape.connectionId,
      /** `owner/name` as GitHub reports it. */
      fullName: z.string().min(1),
      defaultRef: z.string().min(1),
      role: z.literal("linked"),
      linkedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
});

export type RepositoryLinkInput = z.output<typeof repositoryLink.input>;
export type RepositoryLinkOutput = z.output<typeof repositoryLink.output>;
