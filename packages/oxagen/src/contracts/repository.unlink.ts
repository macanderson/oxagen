/**
 * `unlink_repository`: remove a linked repository from the workspace
 * (ADR-212).
 *
 * It is addressed by the binding id that `list_repositories` returns. What it
 * does depends on the steering record:
 *
 *   - When `workspace.toml` on the steering repository's production branch
 *     lists the repository, the handler opens a steering PR that removes the
 *     entry. It answers `status: proposed` with that PR, and `unlinkedAt` is
 *     null. The head goes away when the PR merges and the steering sync reads
 *     the new `workspace.toml`.
 *   - When `workspace.toml` does not list it, the link predates the steering
 *     record. The handler deletes the head at once and answers
 *     `status: unlinked` with `unlinkedAt` set and no PR.
 *
 * Either way the binding versions stay: `ingestion.repository_bindings` is
 * immutable evidence that earlier runs still cite. Linking the repository
 * again writes a successor version rather than a second version 1.
 *
 * Refusals:
 *   - `conflict: main_repo_unlink_refused`: it is the workspace's steering
 *     repository, which this write never removes.
 *   - `not_found: repository_not_linked`: this workspace sees no such binding.
 *   - `conflict: workspace_toml_unreadable`: `workspace.toml` is present but
 *     does not read as `workspace/v1`, so the handler cannot tell which path
 *     applies.
 *
 * Nothing is purged from the graph. The v2 descriptor
 * (`./v2/unlink-repository.ts`) carries the purge-and-deregister target shape
 * until its cutover.
 *
 * Roles: org Owner or Admin, or the workspace's Owner, checked by the handler
 * (INV-29). A settings write: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { steeringPullRequestSchema } from "./repository.link";
import { repositoryMainBind } from "./repository.main.bind";

export const repositoryUnlink = registerCapability({
  name: "unlink_repository",
  domain: "repository",
  description:
    "Unlink a linked repository from the workspace. A repository that workspace.toml lists is removed by a steering PR. The steering repository cannot be unlinked, and binding history is kept.",
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
      bindingId: repositoryMainBind.output.shape.bindingId,
    })
    .strict(),
  output: z
    .object({
      bindingId: repositoryMainBind.output.shape.bindingId,
      /** `owner/name` of the repository. */
      fullName: z.string().min(1),
      status: z.enum(["unlinked", "proposed"]),
      /** When the head was deleted, or null while a steering PR is open. */
      unlinkedAt: z.string().datetime({ offset: true }).nullable(),
      /** The steering PR that removes the entry, or null when `status` is `unlinked`. */
      steeringPullRequest: steeringPullRequestSchema.nullable(),
    })
    .strict(),
});

export type RepositoryUnlinkInput = z.output<typeof repositoryUnlink.input>;
export type RepositoryUnlinkOutput = z.output<typeof repositoryUnlink.output>;
