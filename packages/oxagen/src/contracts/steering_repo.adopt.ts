import { z } from "zod";
import { registerCapability } from "../registry";
import { REPO_HEALTH_STATES } from "../steering-repo/health";

/**
 * adopt_steering_merges: take host merges of pull requests Oxagen opened as
 * Oxagen's own, so a steering repo that reads `diverged` because its owner
 * merged them on GitHub reads healthy again (#5195).
 *
 * The handler adopts every commit on main since the published one, or none.
 * Each must be the merge of a pull request a proposal row in this workspace
 * names, at the head the row recorded, and change exactly that pull
 * request's files. The caller must be someone the governance mode lets merge
 * each of those pull requests. Each adopted commit gets the steering app's
 * adoption check run, the call emits `steering.published` naming the adopter
 * and the commits, and it publishes main as the next steering version.
 *
 * It refuses a workspace with no steering repo (not_found
 * `steering_repo_not_ready`), a repo that is not diverged (conflict
 * `nothing_to_adopt`), a GitLab repo (conflict `adoption_unsupported`), any
 * commit it cannot prove (conflict `adoption_refused`), and a caller the mode
 * does not let merge (forbidden, with the mode's reason). A refusal writes
 * nothing, and Repair settings still offers the revert.
 */
export const steeringRepoAdopt = registerCapability({
  name: "adopt_steering_merges",
  domain: "repository",
  description:
    "Adopt host merges of pull requests Oxagen opened on the workspace's steering repo, then publish main as the next steering version.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  // The handler holds the caller to the governance mode, as a merge does.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  agent: { requiresApproval: true, riskLevel: "high", category: "vcs" },
  input: z.object({}).strict(),
  output: z.object({
    health: z.enum(REPO_HEALTH_STATES),
    adopted: z.array(
      z.object({
        commit: z.string(),
        pullRequest: z.number().int().positive(),
      }),
    ),
    publishedVersion: z.number().int().positive().nullable(),
  }),
});

export type SteeringRepoAdoptOutput = z.output<typeof steeringRepoAdopt.output>;
