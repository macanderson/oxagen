import { z } from "zod";
import { registerCapability } from "../registry";
import { recordEffectSchema } from "../steering-repo/record";

/** How the import ended. */
export const STEERING_IMPORT_OUTCOMES = [
  "imported",
  "provisioned",
  "nothing_to_import",
  "needs_choices",
] as const;

/**
 * import_workspace_steering: move a workspace's steering from `.oxagen/` in the
 * repository it binds to a steering repo (steering spec, Workspace migration;
 * lane S10, #4620, ADR-219).
 *
 * The run reads `.oxagen/` at the old repository's production branch and
 * converts it. The old repository's head becomes linked, and the run creates
 * and binds the steering repo. It then opens the import steering PRs on the
 * steering repo and one cleanup PR on the old repository. A person merges
 * each PR. The run changes no file on a default branch.
 *
 * It answers one outcome:
 *   imported           the steering PRs and the cleanup PR are open
 *   provisioned        the workspace had no repository to read, so the run
 *                      only created the steering repo
 *   nothing_to_import  the workspace already has a steering repo
 *   needs_choices      some v0.1 rules need a kind or some constraints need an
 *                      effect, and nothing changed. Run it again with
 *                      `ruleKinds` and `constraintEffects`, keyed by the
 *                      lineages the answer lists.
 *
 * The run is safe to call again. A finished run answers what it did, and a
 * stopped run resumes at the step that stopped without opening a PR twice.
 * It refuses while another run of the same workspace holds the lease
 * (conflict `steering_import_running`), a repository on a host other than
 * GitHub (conflict `steering_import_provider_unsupported`), a repository
 * Oxagen can no longer reach (conflict `steering_import_source_unreachable`),
 * and a repository the workspace reads with no binding (conflict
 * `steering_import_legacy_connection`). When provisioning fails, the old
 * repository steers the workspace again.
 *
 * Org Owners and Admins, and workspace Owners. The handler checks the role
 * itself (INV-29). The import is a one-time move a person starts, so the
 * contract is not on the agent surface and carries no agent metadata.
 */
export const steeringRepoImport = registerCapability({
  name: "import_workspace_steering",
  domain: "repository",
  description:
    "Move the workspace's steering from .oxagen/ in the repository it binds to a steering repo, and open the steering PRs a person merges.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z
    .object({
      /** The kind of each v0.1 rule, keyed by its old lineage. */
      ruleKinds: z
        .record(z.string(), z.enum(["business-rule", "code-rule"]))
        .optional(),
      /** The effect of each v0.1 constraint, keyed by its old lineage. */
      constraintEffects: z.record(z.string(), recordEffectSchema).optional(),
    })
    .strict(),
  output: z.object({
    outcome: z.enum(STEERING_IMPORT_OUTCOMES),
    /** `owner/name` of the steering repo, once the workspace has one. */
    steeringRepository: z.string().nullable(),
    /** The import steering PRs on the steering repo, in merge order. */
    pullRequests: z.array(
      z.object({
        branch: z.string(),
        number: z.number().int(),
        url: z.string(),
      }),
    ),
    /** The PR that removes the imported files from the old repository. Merge it last. */
    cleanup: z.object({ number: z.number().int(), url: z.string() }).nullable(),
    /** Files, records, and agents the import left for a person. */
    leftForAPerson: z.number().int().nonnegative(),
    /** Old lineages of the v0.1 rules that need a kind. */
    rulesNeedingKind: z.array(z.string()),
    /** Old lineages of the v0.1 constraints that need an effect. */
    constraintsNeedingEffect: z.array(z.string()),
  }),
});

export type SteeringRepoImportOutput = z.output<typeof steeringRepoImport.output>;
