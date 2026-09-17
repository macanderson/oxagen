/**
 * `enroll_host` (MC spec App. E: "device key, host agent, bundle, hooks";
 * §14.1 `oxagen agent enroll`; #2967): a machine becomes a registered agent's
 * host by presenting the single-use enrollment token
 * `create_enrollment_token` minted.
 *
 * The token is the credential: the call carries no session and no API key,
 * so the capability is unscoped and the handler resolves the tenant from the
 * token, then does what `create_tacho_enrollment` does for an operator — the
 * host's scoped API key, the HMAC-signed enrollment the collector verifies
 * offline, the initial policy bundle — with the host bound to the token's
 * agent and its principal. The token is consumed in the same transaction; a
 * second presentation is `conflict: token_used`, an expired one `conflict:
 * token_expired`, an unknown one `not_found: token_unknown`, and each refusal
 * is counted on the token row.
 *
 * `noBillingGate: true`: enrolling a host consumes no governed action.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { tachoEnrollmentCreate } from "./tacho.enrollment.create";
import { enrollmentTokenSchema } from "./tacho.enrollment_token.create";

const source = tachoEnrollmentCreate.input.shape;

export const tachoHostEnroll = registerCapability({
  name: "enroll_host",
  domain: "tacho",
  description:
    "Enrol this machine as a registered agent's host by presenting a single-use enrollment token: mint its scoped API key, signed enrollment and initial policy bundle.",
  mode: "sync",
  // The token is the credential a machine holds; a model never enrols a host.
  surfaces: ["api", "cli"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: false,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  // No principal exists on the call; the token decides.
  defaultEffect: "allow",
  defaultRoles: {
    org: {},
    workspace: {},
  },
  input: z
    .object({
      token: enrollmentTokenSchema,
      hostname: source.hostname,
      osUser: source.osUser,
      platform: source.platform,
      osVersion: source.osVersion,
      arch: source.arch,
      devicePublicKey: source.devicePublicKey,
      harnesses: source.harnesses,
      claudeVersion: source.claudeVersion,
      claudeExecpath: source.claudeExecpath,
      nodeVersion: source.nodeVersion,
      wrapperVersion: source.wrapperVersion,
      /**
       * The host declares which bundle fields its `.strict()` parser names, on
       * the token path too. The CLI sends this on BOTH enrollment paths
       * (`enroll.ts` posts it to `/v1/tacho/enroll`), so omitting it here made
       * this `.strict()` input reject every CLI enrollment that carried it.
       */
      bundleFeatures: source.bundleFeatures,
      shell: source.shell,
      managed: source.managed,
      validityDays: source.validityDays,
      /**
       * The git remote of the directory the installer ran in (spec App. F:
       * "The installer reads the git remote of the directory it ran in. It
       * offers that remote as the main repo"). Recorded on the gate while it
       * is open; ignored afterwards.
       */
      repositoryRemote: z.string().min(1).max(2048).optional(),
    })
    .strict(),
  output: z
    .object({
      ...tachoEnrollmentCreate.output.shape,
      agentId: z.string().regex(/^agt_[0-9a-z]+$/),
      orgSlug: z.string().min(1),
      workspaceSlug: z.string().min(1),
    })
    .strict(),
});

export type TachoHostEnrollInput = z.output<typeof tachoHostEnroll.input>;
export type TachoHostEnrollOutput = z.output<typeof tachoHostEnroll.output>;
