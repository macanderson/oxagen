/**
 * `list_installation_repositories`: the repositories the workspace's GitHub App
 * installation can see, so a person can pick one to link (MC spec §10.1;
 * #2967).
 *
 * This is the picker behind `link_repository`. `link_repository` resolves the
 * repository through the installation's token and answers
 * `not_found: repository_not_installed` for anything that token cannot read.
 * A picker built from any other list (the user's own repositories, a typed
 * `owner/name`) would offer options that refuse on submit.
 *
 * As with `link_repository`, the caller names no installation. It is taken
 * from the workspace's GitHub connection, the one the HMAC-verified install
 * callback attached. An installation id a caller could choose would let one
 * tenant enumerate another account's repositories. A workspace with no
 * installation is `conflict: github_not_connected`, the same refusal
 * `link_repository` gives, which is what `get_main_repository` reports before
 * this is called.
 *
 * `truncated` is honest rather than paginated: the installation token lists
 * repositories a page at a time and this read walks a bounded number of pages.
 * An installation granted access to more repositories than that says so, and
 * the surface tells the person to narrow the App's repository access on GitHub
 * (`github.manageUrl`) rather than silently hiding the repository they want.
 *
 * Roles: org Owner or Admin, checked by the handler (INV-29). A settings
 * read: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const repositoryInstallationList = registerCapability({
  name: "list_installation_repositories",
  domain: "repository",
  description:
    "The repositories the workspace's GitHub App installation can reach. The app's link picker offers these to link_repository.",
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
