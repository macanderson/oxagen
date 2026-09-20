/**
 * Revoke a Tacho host enrollment (docs/specs/tacho/spec.md section 7.4).
 * The host's API key is soft-deleted, its status becomes `suspended` then
 * `revoked`, and every running session on it is denied at its next boundary
 * once the collector reads the new status from the bundle.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { hostEnrollmentIdSchema } from "../tacho/schemas";

export const tachoEnrollmentRevoke = registerCapability({
  name: "revoke_tacho_enrollment",
  domain: "tacho",
  description:
    "Revoke a Tacho host enrollment: retire its API key and deny every session on the host at its next boundary.",
  mode: "sync",
  // `app` is a layer, not a surface: CapabilitySurface is api | mcp | agent |
  // cli, and apps/app reaches the kernel through its own seam
  // (apps/app/src/server/kernel.ts), which passes surface "app" and never
  // consults this allowlist. The Enrollment tab of an agent's page revokes a
  // host through it, so the layer is claimed and bound in
  // apps/app/capability-ui-map.json; the surface stays the HTTP one.
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      hostEnrollmentId: hostEnrollmentIdSchema,
      reason: z.string().max(512).optional(),
    })
    .strict(),
  output: z
    .object({
      hostEnrollmentId: hostEnrollmentIdSchema,
      status: z.literal("revoked"),
      revokedAt: z.string(),
    })
    .strict(),
});

export type TachoEnrollmentRevokeInput = z.output<
  typeof tachoEnrollmentRevoke.input
>;
export type TachoEnrollmentRevokeOutput = z.output<
  typeof tachoEnrollmentRevoke.output
>;
