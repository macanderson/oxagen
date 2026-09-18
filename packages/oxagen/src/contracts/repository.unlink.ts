/**
 * `unlink_repository`: remove a LINKED repository from the workspace (Mission
 * Control spec §10.1; §17 M0 "a second repo can be linked and unlinked").
 *
 * Addressed by the binding id `list_repositories` and `link_repository`
 * answer. The handler removes the repository's binding HEAD — the mutable
 * pointer that says "this workspace sees this repository" — and leaves every
 * binding version in place: `ingestion.repository_bindings` is immutable
 * evidence that runs admitted against it still cite. Linking the repository
 * again writes a successor version rather than a second version 1.
 *
 * The main repository is refused, `conflict: main_repo_unlink_refused`: a
 * workspace without a main repo cannot exist (§10.1), so it is never removed
 * by this write. A binding id this workspace does not see is
 * `not_found: repository_not_linked`.
 *
 * Nothing is purged from the graph; the v2 descriptor
 * (`./v2/unlink-repository.ts`) carries the purge-and-deregister target shape
 * until its cutover.
 *
 * Roles: org Owner or Admin, or the workspace's Owner, checked by the handler
 * (INV-29). A settings write: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { repositoryMainBind } from "./repository.main.bind";

export const repositoryUnlink = registerCapability({
  name: "unlink_repository",
  domain: "repository",
  description:
    "Unlink a linked repository from the workspace. The main repository cannot be unlinked; binding history is kept.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
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
      /** `owner/name` of the repository that was unlinked. */
      fullName: z.string().min(1),
      unlinkedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
});

export type RepositoryUnlinkInput = z.output<typeof repositoryUnlink.input>;
export type RepositoryUnlinkOutput = z.output<typeof repositoryUnlink.output>;
