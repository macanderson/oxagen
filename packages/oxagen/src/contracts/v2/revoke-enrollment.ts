import { z } from "zod";
import { defineTool } from "./_define";
import { tachoEnrollmentRevoke } from "../tacho.enrollment.revoke";

/**
 * Appendix E: `revoke_enrollment`. Absorbs `revoke_tacho_enrollment`. The
 * appendix leaves the `Does` column empty, which means the v1 job is the v2
 * job: retire the host's credential and deny every run on it.
 *
 * A clean 1:1 carry, so `drops` is `[]`.
 *
 * **Why `reason` stays optional even though §14 says every explanation is a
 * chain of links.** That rule is about how the interface *renders* a decision,
 * not about forcing prose at the API. §7.4's guarantee for `revoke` is "host
 * suspended in bundle. Denies even if the daemon is down" — the denial is
 * mechanical and must not be blocked on an operator finding words for it. The
 * accountability chain comes from the audit row and the `policy.decision`
 * frames the revoke produces, which exist whether or not a reason was typed.
 *
 * **Why the deny-generation bump is not in the output.** §7.4 lists
 * `deny_generation bump` as its own command, and the effect of a revoke on
 * cached bundles is already observable where it matters: the next
 * `get_policy_bundle` returns a changed etag and a `suspended` host status.
 * Restating it here would be a second copy of a number the bundle already
 * carries, and the two could disagree.
 */
export const revokeEnrollment = defineTool({
  name: "revoke_enrollment",
  domain: "control",
  description:
    "Revoke a host enrollment: retire its credential and deny every run on the host at its next boundary.",
  mode: "sync",
  // Same reasoning as `enroll_host`: revoking a host's credential is an
  // operator action on the trust boundary, so it is not reachable from a model.
  surfaces: ["api", "cli"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,

  absorbs: ["revoke_tacho_enrollment"],
  drops: [],

  // Carried unchanged. Revocation is the stronger half of the enrollment pair
  // and shares its grade: an operator who may enrol a host may retire it.
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  // Soft-deletes the API key and moves control.enrollments.status to `revoked`.
  mutates: true,

  input: z.object({
    hostEnrollmentId: tachoEnrollmentRevoke.input.shape.hostEnrollmentId,
    // 512 chars: long enough for an incident reference, short enough that a
    // revoke reason cannot become an unbounded free-text column.
    reason: tachoEnrollmentRevoke.input.shape.reason,
  }),

  output: z.object({
    hostEnrollmentId: tachoEnrollmentRevoke.output.shape.hostEnrollmentId,
    /**
     * Literal `"revoked"`, carried as a literal on purpose: the v1 handler
     * moves a host through `suspended` on its way here, and a caller that saw
     * the intermediate state would have to decide whether the revoke took.
     * This tool only returns once it did.
     */
    status: tachoEnrollmentRevoke.output.shape.status,
    revokedAt: tachoEnrollmentRevoke.output.shape.revokedAt,
  }),
});

export type RevokeEnrollmentInput = z.output<typeof revokeEnrollment.input>;
export type RevokeEnrollmentOutput = z.output<typeof revokeEnrollment.output>;
