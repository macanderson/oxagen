/**
 * `set_production_branch`: confirm or change the production branch of one of
 * the workspace's repositories (Mission Control spec §10.1, §11.4).
 *
 * The production branch is the only branch whose commits update the code
 * graph, the only one `.oxagen/` is read from, and the only one a Context PR
 * merges into. GitHub's default branch is the suggestion; the person decides.
 * A new head records GitHub's default branch when it is written. This
 * capability confirms or changes it: any branch that exists on GitHub, named
 * by the caller.
 *
 * The handler reads the branch through the workspace's installation (a branch
 * GitHub does not know is `not_found: branch_not_found`) and, when it differs
 * from what the binding records, writes a successor binding version carrying
 * it and moves the head onto that version. Binding versions are immutable, so
 * runs already admitted against the old branch keep citing it. Naming the
 * branch the binding already records writes nothing and answers
 * `changed: false`.
 *
 * Refusals: `not_found: repository_not_linked`, `conflict: github_not_connected`,
 * `not_found: repository_not_installed` (the installation no longer reaches
 * the repository), `not_found: branch_not_found`.
 *
 * Roles: the main repository's branch is where steering lives, so it takes an
 * org Owner or Admin. A linked repository's branch also admits the workspace
 * Owner, as `link_repository` does. Checked by the handler (INV-29). A
 * settings write: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { repositoryBindingIdSchema } from "./repository.shared";

/** A git branch name as GitHub accepts one: no spaces, no `..`, no leading `-`. */
export const branchName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/)
  .refine((b) => !b.endsWith("/") && !b.endsWith(".lock"), {
    message: "not a branch name git accepts",
  });

export const repositoryProductionBranchSet = registerCapability({
  name: "set_production_branch",
  domain: "repository",
  description:
    "Confirm or change the production branch of one of the workspace's repositories. The branch must exist on GitHub; a change writes a new binding version and never edits the old one.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  agent: { requiresApproval: true, riskLevel: "high", category: "vcs" },
  input: z
    .object({
      bindingId: repositoryBindingIdSchema,
      branch: branchName,
    })
    .strict(),
  output: z
    .object({
      /** The binding the head points at now: the successor when `changed`. */
      bindingId: repositoryBindingIdSchema,
      fullName: z.string().min(1),
      productionBranch: z.string().min(1),
      previousBranch: z.string().min(1),
      changed: z.boolean(),
      setAt: z.string().datetime({ offset: true }),
    })
    .strict(),
});

export type RepositoryProductionBranchSetInput = z.output<
  typeof repositoryProductionBranchSet.input
>;
export type RepositoryProductionBranchSetOutput = z.output<
  typeof repositoryProductionBranchSet.output
>;
