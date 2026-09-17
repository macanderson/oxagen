/**
 * `list_installation_repositories`: the repositories the workspace's GitHub App
 * installation can see, so a person can pick which one becomes the main repo
 * (MC spec §10.1; #2967).
 *
 * This is the picker behind `bind_main_repository`. It exists so the choice on
 * screen and the choice the write accepts are the same set: the bind resolves
 * the repository through the installation's token and answers
 * `not_found: repository_not_installed` for anything that token cannot read, so
 * a picker built from any other list (the user's own repositories, a typed
 * `owner/name`) would offer options that refuse on submit.
 *
 * Like the bind, the caller names no installation. It is taken from the
 * workspace's GitHub connection — the one the HMAC-verified install callback
 * attached — because an installation id a caller could choose would let one
 * tenant enumerate another account's repositories. A workspace with no
 * installation is `conflict: github_not_connected`, the same refusal the bind
 * gives, which is what `get_main_repository` reports before this is called.
 *
 * `truncated` is honest rather than paginated: the installation token lists
 * repositories a page at a time and this read walks a bounded number of pages.
 * An installation granted access to more repositories than that says so, and
 * the surface tells the person to narrow the App's repository access on GitHub
 * (`github.manageUrl`) rather than silently hiding the repository they want.
 *
 * Roles: org Owner or Admin, checked by the handler (INV-29) — the pair that
 * may bind. A settings read: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const repositoryInstallationList = registerCapability({
  name: "list_installation_repositories",
  domain: "repository",
  description:
    "The repositories the workspace's GitHub App installation can reach, the set bind_main_repository will accept.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({}).strict(),
  output: z
    .object({
      repositories: z.array(
        z
          .object({
            /** GitHub's numeric repository id as text; survives renames and transfers. */
            id: z.string().min(1),
            owner: z.string().min(1),
            name: z.string().min(1),
            /** `owner/name` as GitHub reports it. */
            fullName: z.string().min(1),
            defaultBranch: z.string().min(1),
            private: z.boolean(),
            htmlUrl: z.string().url(),
          })
          .strict(),
      ),
      /** True when the installation reaches more repositories than this read walked. */
      truncated: z.boolean(),
    })
    .strict(),
});

export type RepositoryInstallationListInput = z.output<
  typeof repositoryInstallationList.input
>;
export type RepositoryInstallationListOutput = z.output<
  typeof repositoryInstallationList.output
>;
