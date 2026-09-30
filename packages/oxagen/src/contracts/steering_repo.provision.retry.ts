import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * retry_steering_repo_provision: re-send a failed or blocked steering repo
 * setup, so it runs again from its first step (#4750).
 *
 * The provisioning job (`provisionSteeringRepo`) always starts its loop at
 * the first step, but each step adopts or skips work it already finished by
 * checking the state fields that step owns (a created repository, a chosen
 * candidate name, and so on). The handler therefore only flips `status` back
 * to `provisioning` and clears the recorded `error`; it leaves every other
 * state field as the failed run left it, so the job resumes rather than
 * starts over. It refuses a scope with no steering repo state to retry
 * (not_found `no_steering_repo_state`) and is a no-op, answering the current
 * status, when that status is not already `failed` or `blocked`.
 *
 * Org Owners and Admins only, the same as `repair_steering_repo`. Retry is
 * the health banner's other admin button. Stella can run it too, and each
 * call waits for a person's approval (#4180).
 */
export const steeringRepoProvisionRetry = registerCapability({
  name: "retry_steering_repo_provision",
  domain: "repository",
  description:
    "Re-send a failed or blocked steering repo setup so the job runs again from its first step.",
  mode: "sync",
  surfaces: ["api", "agent"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  agent: { requiresApproval: true, riskLevel: "medium", category: "vcs" },
  input: z.object({}).strict(),
  output: z.object({
    status: z.enum(["provisioning", "ready", "failed", "blocked"]),
  }),
});

export type SteeringRepoProvisionRetryOutput = z.output<
  typeof steeringRepoProvisionRetry.output
>;
