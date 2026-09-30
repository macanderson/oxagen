import { z } from "zod";
import { registerCapability } from "../registry";
import { REPO_HEALTH_STATES } from "../steering-repo/health";

/**
 * repair_steering_repo: put every prescribed setting back on the workspace's
 * steering repo (steering-repo-spec, Settings drift; lane S2, #4560).
 *
 * The handler writes every baseline setting the host shows differently. When
 * main diverged from the published commit, it also merges the pull request
 * that puts main back. It then reads the health again and answers what that
 * read finds. It refuses a repo Oxagen can no longer reach (conflict
 * `steering_repo_disconnected`), a workspace with no steering repo yet
 * (not_found `steering_repo_not_ready`), a deployment with no Oxagen GitHub App
 * settings (conflict `steering_app_unconfigured`), and a revert the host
 * will not merge (conflict `steering_revert_refused`).
 *
 * Org Owners and Admins only. The handler checks the role itself (INV-29).
 * Repair is the health banner's admin button. Stella can run it too, and each
 * call waits for a person's approval, because it rewrites the repo's settings
 * (#4180).
 */
export const steeringRepoRepair = registerCapability({
  name: "repair_steering_repo",
  domain: "repository",
  description:
    "Put every prescribed setting back on the workspace's steering repo, then read the settings again and answer the health that read finds.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
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
  agent: { requiresApproval: true, riskLevel: "high", category: "vcs" },
  input: z.object({}).strict(),
  output: z.object({ health: z.enum(REPO_HEALTH_STATES) }),
});

export type SteeringRepoRepairOutput = z.output<typeof steeringRepoRepair.output>;
