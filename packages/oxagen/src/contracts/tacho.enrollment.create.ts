/**
 * Enrol a machine as a Tacho host (docs/specs/tacho/spec.md section 5.2).
 *
 * The operator half of the host trust boundary: `ingest_tacho_events`
 * refuses any batch whose API key does not carry the server-owned
 * `tacho_host_v1` scope, and `create_api_key` / `rotate_api_key` refuse to
 * mint or preserve that scope. This capability is the only writer of it.
 *
 * Returns, once each and never again: the host API key, the HMAC-signed
 * enrollment document the collector verifies offline, the initial signed
 * policy bundle, and the bundle-signing public key.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  enrollmentClaimsSchema,
  hostEnrollmentIdSchema,
  policyBundleSchema,
  tachoHarnessSchema,
  tachoPlatformSchema,
} from "../tacho/schemas";

const MAX_VALIDITY_DAYS = 365;

export const tachoEnrollmentCreate = registerCapability({
  name: "create_tacho_enrollment",
  domain: "tacho",
  description:
    "Enrol a machine as a Tacho host: mint its scoped API key, signed enrollment, and initial policy bundle.",
  mode: "sync",
  // Operator action: an agent must not be able to mint the credential that
  // lets a machine report into the workspace.
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
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
      hostname: z.string().min(1).max(253),
      osUser: z.string().min(1).max(128),
      platform: tachoPlatformSchema,
      osVersion: z.string().max(128).optional(),
      arch: z.string().max(32).optional(),
      /** Ed25519 public key, `ed25519:<base64 SPKI or raw 32 bytes>`. */
      devicePublicKey: z.string().regex(/^ed25519:[A-Za-z0-9+/=]{40,}$/),
      harnesses: z.array(tachoHarnessSchema).min(1).max(4),
      claudeVersion: z.string().max(32).optional(),
      claudeExecpath: z.string().max(1024).optional(),
      nodeVersion: z.string().max(32).optional(),
      wrapperVersion: z.string().max(32).optional(),
      /**
       * The bundle fields this host's parser understands
       * (`TACHO_BUNDLE_FEATURES` in `@oxagen/tacho`).
       *
       * The enrollment response carries the host's first policy bundle, and
       * the host parses it with a `.strict()` schema, so a field it does not
       * name fails the whole enrollment. Declaring what it can read is what
       * lets the control plane add a bundle field without breaking every
       * installed CLI on the day it deploys. Optional and empty are the same
       * answer: a client that does not send it predates the field it would be
       * asking for.
       */
      bundleFeatures: z.array(z.string().max(64)).max(32).optional(),
      shell: z.string().max(128).optional(),
      managed: z.boolean().default(false),
      validityDays: z.number().int().min(1).max(MAX_VALIDITY_DAYS).default(180),
    })
    .strict(),
  output: z
    .object({
      hostEnrollmentId: hostEnrollmentIdSchema,
      agentKey: z.string().min(1),
      apiKeyPublicId: z.string().min(1),
      /** Shown once. Never recoverable. */
      apiKey: z.string().min(1),
      /**
       * The second credential: what the host's local MCP gateway serves a
       * connected app's tools with (ADR-078). Optional so a client built
       * before the gateway existed still parses this response.
       *
       * It is a separate key from `apiKey` because the two do different jobs
       * with different blast radii — the host key reports events and fetches
       * its mandate, the gateway key answers an app's tool calls — and one
       * credential doing both is what let a connected app inherit the host's
       * authority. `machineKeyDenial` holds each to its own purpose.
       */
      gatewayApiKeyPublicId: z.string().min(1).optional(),
      /** Shown once. Never recoverable. */
      gatewayApiKey: z.string().min(1).optional(),
      enrollment: z
        .object({
          claims: enrollmentClaimsSchema,
          signature_hex: z.string().regex(/^[0-9a-f]{64}$/),
          verification_secret_env: z.string().min(1),
        })
        .strict(),
      policyBundle: policyBundleSchema,
      bundlePublicKeyPem: z.string().min(1),
      expiresAt: z.string(),
    })
    .strict(),
});

export type TachoEnrollmentCreateInput = z.output<
  typeof tachoEnrollmentCreate.input
>;
export type TachoEnrollmentCreateOutput = z.output<
  typeof tachoEnrollmentCreate.output
>;
