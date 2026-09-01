// telemetry.stella.enroll.ts — the ONLY writer of the server-owned Stella
// telemetry enrollment columns.
//
// `create_api_key` explicitly refuses the reserved scope purpose, and no other
// contract can set `stella_telemetry_enrollment_id` / `_enrolled_at`. That is
// the intake trust boundary: a caller must not be able to self-assert that its
// key is enrolled. This handler is the operator-side door through it, and
// everything it writes is derived here — never taken from the input.
//
// Flow:
//   1. Auth + role gate (org Owner/Admin), same as api.key.create.
//   2. Enterprise-tier gate, matching what the ingest handler demands — an
//      enrollment that ingest would refuse is not worth minting.
//   3. Endpoint gate: the endpoint must be one THIS deployment serves.
//   4. Mint the key and the enrollment id, and write both the scope and the
//      server-owned columns in one insert.
//   5. Sign the claims with the encoding stella verifies, and return the
//      managed settings document plus the raw key — each shown once.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { telemetryStellaEnroll } from "@oxagen/oxagen/contracts/telemetry.stella.enroll";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  API_KEY_AUTHORIZED_ROLES as AUTHORIZED_ROLES,
  resolveActorOrgRole as resolveActorRole,
  generateApiKey,
} from "./lib/api-key-authz";
import { STELLA_OPERATIONAL_TELEMETRY_SCOPE_PURPOSE } from "./lib/stella-telemetry-enrollment";
import {
  ENROLLMENT_CLAIMS_SCHEMA,
  signEnrollmentClaims,
  type StellaEnrollmentClaims,
} from "./lib/stella-enrollment-signing";
import { logger } from "./logger";

/**
 * The env var holding the HMAC secret this deployment signs enrollments with.
 * Stella verifies against its own copy, named by the managed document's
 * `verification_secret_env`; the two are the same secret, distributed out of
 * band. Absent ⇒ this capability refuses rather than minting an enrollment no
 * install could verify.
 */
const SIGNING_SECRET_ENV = "STELLA_ENROLLMENT_SIGNING_SECRET";

/** What Stella records the issuer and audience as. Fixed, not caller-supplied. */
const ISSUER = "oxagen-enterprise";
const AUDIENCE = "stella-cli";

/** `sten_` + 20 hex, matching the enrollment-id pattern the DB CHECK enforces. */
function generateEnrollmentId(): string {
  return `sten_${randomBytes(10).toString("hex")}`;
}

function denied(message: string): CapabilityError {
  return new CapabilityError(
    "create_stella_enrollment",
    "authz_denied",
    message,
  );
}

export const telemetryStellaEnrollHandler: CapabilityHandler<
  typeof telemetryStellaEnroll
> = async (input, ctx) => {
  if (!ctx.userId) throw denied("Unauthorized: no authenticated user");
  if (!ctx.orgId) throw denied("Forbidden: orgId is required");
  if (!ctx.workspaceId) throw denied("Forbidden: workspaceId is required");

  const actorRole = await resolveActorRole(ctx.orgId, ctx.userId);
  if (!actorRole || !AUTHORIZED_ROLES.has(actorRole)) {
    logger.warn(
      { orgId: ctx.orgId, actorRole },
      "telemetry.stella.enroll: rejected — insufficient org role",
    );
    throw denied(
      "Forbidden: only org Owners and Admins can enrol Stella telemetry",
    );
  }

  const secret = process.env[SIGNING_SECRET_ENV];
  if (!secret) {
    // Refuse rather than mint: an unsigned or wrongly-signed document is
    // rejected by the install, and discovering that at the install is far
    // worse than discovering it here.
    logger.error(
      {},
      `telemetry.stella.enroll: ${SIGNING_SECRET_ENV} is not set — cannot sign an enrollment`,
    );
    // A plain Error, not a CapabilityError: this is a deployment
    // misconfiguration, not a decision about this caller — the same shape
    // api.key.create uses for "the insert came back empty".
    throw new Error(
      `Stella enrollment signing is not configured: ${SIGNING_SECRET_ENV} is unset`,
    );
  }

  // The endpoint must be one this deployment actually serves. Without this an
  // operator could mint a signed document pointing a fleet of installs at a
  // third party — the signature would verify, and the telemetry would leave.
  const allowedEndpoints = resolveAllowedEndpoints();
  if (!allowedEndpoints.includes(input.endpoint)) {
    throw denied(
      `Forbidden: endpoint must be one of this deployment's ingest endpoints (${allowedEndpoints.join(", ")})`,
    );
  }

  const activeSubscription = await withTenantDb((tx) =>
    tx.query.subscriptions.findFirst({
      where: and(
        eq(schema.subscriptions.orgId, ctx.orgId),
        eq(schema.subscriptions.status, "active"),
      ),
      columns: { id: true, status: true },
      with: { plan: { columns: { tier: true } } },
    }),
  );
  if (activeSubscription?.plan.tier !== "enterprise") {
    // The ingest handler demands this too; minting an enrollment whose batches
    // would be refused on arrival is a worse failure than refusing here.
    throw denied("Forbidden: active Enterprise subscription required");
  }

  const enrollmentId = generateEnrollmentId();
  const { rawKey, keyPrefix, keyHash } = generateApiKey();
  const issuedAt = new Date();
  const expiresAt = new Date(
    issuedAt.getTime() + input.validityDays * 24 * 60 * 60 * 1000,
  );

  const [inserted] = await withTenantDb((tx) =>
    tx
      .insert(schema.apiKeys)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        keyPrefix,
        keyHash,
        name: input.name,
        // Both halves are written here, together: the scope the ingest handler
        // parses, and the server-owned provenance columns it checks the scope
        // against. Writing one without the other trips the paired-NULL CHECK.
        scope: {
          purpose: STELLA_OPERATIONAL_TELEMETRY_SCOPE_PURPOSE,
          enrollment_id: enrollmentId,
        },
        stellaTelemetryEnrollmentId: enrollmentId,
        stellaTelemetryEnrolledAt: issuedAt,
        expiresAt,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning({ publicId: schema.apiKeys.publicId }),
  );
  if (!inserted) {
    throw new Error("Internal error: failed to create the enrollment API key");
  }

  const claims: StellaEnrollmentClaims = {
    schema: ENROLLMENT_CLAIMS_SCHEMA,
    issuer: ISSUER,
    audience: AUDIENCE,
    enrollment_id: enrollmentId,
    organization_id: ctx.orgId,
    workspace_id: ctx.workspaceId,
    endpoint: input.endpoint,
    credential_env: input.credentialEnv,
    // Operational rollups only. `compliance_audit` is a separate decision with
    // its own review; an enrollment minted here cannot quietly carry it.
    event_classes: ["execution_rollup"],
    host_data_isolation: "process_free",
    model_catalog: input.modelCatalog,
    issued_at_unix_s: Math.floor(issuedAt.getTime() / 1000),
    expires_at_unix_s: Math.floor(expiresAt.getTime() / 1000),
  };

  const managedSettings = {
    verification_secret_env: SIGNING_SECRET_ENV,
    allowed_issuers: [ISSUER],
    allowed_audiences: [AUDIENCE],
    allowed_endpoints: allowedEndpoints,
    host_data_isolation: "process_free",
    enrollment: {
      claims,
      signature_hex: signEnrollmentClaims(claims, secret),
    },
  };

  emitSecurityEvent({
    eventType: "api_key.created",
    actorUserId: ctx.userId,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    capability: "create_stella_enrollment",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, enrollmentId },
    "telemetry.stella.enroll: enrollment minted",
  );

  return {
    enrollmentId,
    apiKeyPublicId: inserted.publicId,
    apiKey: rawKey,
    managedSettings,
    expiresAt: expiresAt.toISOString(),
  };
};

/**
 * The ingest endpoints this deployment serves.
 *
 * Read from `STELLA_TELEMETRY_INGEST_ENDPOINTS` (comma-separated) so a
 * self-hosted deployment can name its own origin; falls back to the public
 * one. Every entry must be HTTPS — stella refuses a plaintext endpoint at the
 * install, so minting one would produce a document no install accepts.
 */
function resolveAllowedEndpoints(): string[] {
  const raw = process.env["STELLA_TELEMETRY_INGEST_ENDPOINTS"];
  const endpoints = raw
    ? raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : ["https://api.oxagen.sh/v1/telemetry/stella/operational"];
  return endpoints.filter((entry) => entry.startsWith("https://"));
}
