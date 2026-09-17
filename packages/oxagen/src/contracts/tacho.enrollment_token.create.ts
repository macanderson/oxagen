/**
 * `create_enrollment_token`: the one-time enrollment token for a registered
 * agent (MC spec §7.2 "a signed installer link with a one-time enrollment
 * token embedded"; mockup `REG_TOKEN` "expires in 30 min · single use";
 * #2967).
 *
 * The token is what a machine presents to `enroll_host` in place of an
 * operator session: it names the agent the host will report as, is shown to
 * the operator exactly once, is stored as a digest, and is consumed the first
 * time it is presented. Issuing a token writes nothing to the agent; a token
 * that expires unused is replaced by issuing another.
 *
 * Roles: org Owner or Admin, checked by the handler (INV-29), the same gate
 * `create_tacho_enrollment` keeps because both mint the path a machine takes
 * into the workspace. A credential mint, outside the metering surface:
 * `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const ENROLLMENT_TOKEN_TTL_MINUTES_DEFAULT = 30;
const ENROLLMENT_TOKEN_TTL_MINUTES_MAX = 60;

/** `oxe_1time_` then 26 Crockford base32 characters. */
export const enrollmentTokenSchema = z
  .string()
  .regex(/^oxe_1time_[0-9a-hjkmnp-tv-z]{26}$/);

export const tachoEnrollmentTokenCreate = registerCapability({
  name: "create_enrollment_token",
  domain: "tacho",
  description:
    "Mint the single-use enrollment token a machine presents to enroll_host to become the named agent's host. Shown once; expires unused after its TTL.",
  mode: "sync",
  // A credential mint: never reachable by a model (no agent, no MCP).
  surfaces: ["api", "cli"],
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
  input: z
    .object({
      /** The registered agent (`agt_…`) the token enrols a host for. */
      agentId: z.string().regex(/^agt_[0-9a-z]+$/),
      ttlMinutes: z
        .number()
        .int()
        .min(1)
        .max(ENROLLMENT_TOKEN_TTL_MINUTES_MAX)
        .default(ENROLLMENT_TOKEN_TTL_MINUTES_DEFAULT),
    })
    .strict(),
  output: z
    .object({
      tokenId: z.string().regex(/^tet_[0-9a-z]+$/),
      /** Shown once. Never recoverable. */
      token: enrollmentTokenSchema,
      expiresAt: z.string().datetime({ offset: true }),
      agentId: z.string().regex(/^agt_[0-9a-z]+$/),
      /** `org_ns.ws_ns.slug` (ADR-024): the key the enrolled host reports as. */
      agentKey: z.string().min(1),
      /** The scripted path (spec §14.1): `oxagen agent enroll --token …`. */
      enrollCommand: z.string().min(1),
    })
    .strict(),
});

export type TachoEnrollmentTokenCreateInput = z.output<
  typeof tachoEnrollmentTokenCreate.input
>;
export type TachoEnrollmentTokenCreateOutput = z.output<
  typeof tachoEnrollmentTokenCreate.output
>;
