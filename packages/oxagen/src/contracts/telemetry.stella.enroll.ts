/**
 * Mint a signed Stella enterprise-telemetry enrollment for a workspace.
 *
 * This is the missing half of `ingest_stella_operational_telemetry`. That
 * handler refuses any batch whose API key does not carry the server-owned
 * `stella_telemetry_enrollment_id` / `_enrolled_at` columns — and those columns
 * are deliberately unwritable by `create_api_key` / `rotate_api_key`, so that a
 * caller cannot self-assert the reserved scope. The result was a closed door
 * with no key: nothing in the platform could enrol anyone.
 *
 * This capability is that key, and it is the ONLY writer of those columns.
 *
 * ## What it returns
 *
 * Two secrets, once each, and never again:
 *
 * - `apiKey` — the bearer the Stella install sends the batch with.
 * - `managedSettings` — the org-managed settings document a managed Stella
 *   install accepts, including HMAC-signed `EnrollmentClaims`. Stella verifies
 *   the signature against a secret it holds in its own environment, so a forged
 *   document is refused at the install rather than at the wire.
 *
 * The claims are signed with the encoding stella's `canonical_enrollment_bytes`
 * defines, pinned to a shared conformance vector on both sides — see
 * `packages/handlers/src/lib/stella-enrollment-signing.ts`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/** Stella clamps every reported dimension to this catalog, or to "other". */
const modelDimensionSchema = z
  .object({
    provider: z.string().min(1).max(64),
    model: z.string().min(1).max(128),
  })
  .strict();

/** Stella caps an enrollment at 90 days; anything longer is refused there. */
const MAX_VALIDITY_DAYS = 90;

export const telemetryStellaEnroll = registerCapability({
  name: "create_stella_enrollment",
  domain: "telemetry",
  description:
    "Mint a signed Stella enterprise-telemetry enrollment and its bound API key for this workspace.",
  mode: "sync",
  // API only. An agent must not be able to mint the credential that lets a
  // machine report into the workspace — this is an operator action.
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
      /** Shown in the API-key list so an operator can tell enrollments apart. */
      name: z.string().min(1).max(120),
      /**
       * Where the install POSTs its batches. Must be one of this deployment's
       * own ingest endpoints — the handler refuses anything else, so an
       * enrollment cannot be pointed at a third party.
       */
      endpoint: z.string().url().max(512),
      /**
       * The environment variable the Stella install reads its bearer from.
       * A name, never the value: the secret lives in the install's own
       * environment, and this document is not where it travels.
       */
      credentialEnv: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Z][A-Z0-9_]*$/, "an environment variable name"),
      modelCatalog: z.array(modelDimensionSchema).min(1).max(64),
      validityDays: z.number().int().min(1).max(MAX_VALIDITY_DAYS).default(90),
    })
    .strict(),
  output: z
    .object({
      enrollmentId: z.string().min(1),
      apiKeyPublicId: z.string().min(1),
      /** Shown once. Never recoverable. */
      apiKey: z.string().min(1),
      /** The org-managed settings document, ready to hand to the install. */
      managedSettings: z.record(z.string(), z.unknown()),
      expiresAt: z.string(),
    })
    .strict(),
});

export type TelemetryStellaEnrollInput = z.output<
  typeof telemetryStellaEnroll.input
>;
export type TelemetryStellaEnrollOutput = z.output<
  typeof telemetryStellaEnroll.output
>;
