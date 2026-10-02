import { z } from "zod";
import { registerCapability } from "../registry";
import {
  steeringConnectionPick,
  steeringRepoNameInput,
} from "./steering_repo.shared";

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
 * A setup that stopped with `choose_connection` takes `connection`: one of the
 * GitHub organizations or GitLab groups `get_steering_repo` lists in
 * `connectionChoices`. The handler stores it as the organization's steering
 * connection before it re-sends the job, and refuses one that is not on the
 * list (conflict `unknown_connection`).
 *
 * A workspace whose setup has not created its repository yet also takes
 * `name` and `connection` to change where the repository goes and what it is
 * called, such as after `repository_name_taken` or a refused create. The
 * `connection` must be one `list_steering_repo_destinations` lists, and the
 * job checks it again. Once the repository exists, both are refused (conflict
 * `repository_exists`).
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
  input: z
    .object({
      connection: steeringConnectionPick
        .describe(
          "The GitHub organization or GitLab group to create the steering repo in. After choose_connection, one of get_steering_repo's connectionChoices. For a workspace with no repository yet, any of list_steering_repo_destinations' destinations.",
        )
        .optional(),
      name: steeringRepoNameInput
        .describe(
          "A new name for the workspace's steering repo, while it has no repository yet. Oxagen creates exactly this name.",
        )
        .optional(),
      resetConnection: z
        .boolean()
        .describe(
          "Set true to clear the organization's stored steering connection first, so the run lists the GitHub organizations and GitLab groups again. Refused (conflict connection_in_use) once Oxagen has created a steering repo in the stored one.",
        )
        .optional(),
    })
    .strict(),
  output: z.object({
    status: z.enum(["provisioning", "ready", "failed", "blocked"]),
  }),
});

export type SteeringRepoProvisionRetryOutput = z.output<
  typeof steeringRepoProvisionRetry.output
>;
