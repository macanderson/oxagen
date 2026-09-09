// tacho.enrollment.create.ts — the ONLY writer of the server-owned Tacho host
// scope (`tacho_host_v1`) on an API key, and of a tacho.hosts row.
//
// Flow (spec section 5.2):
//   1. Auth + role gate (org Owner/Admin), same as api.key.create.
//   2. Signing material present: the enrollment HMAC secret and the bundle
//      Ed25519 key. Missing either is a deployment defect; refuse here
//      rather than mint a document no host could verify.
//   3. Endpoint gate: the machine endpoints in the document must be ones THIS
//      deployment serves.
//   4. Derive the host's agentKey from the org and workspace namespaces
//      (ADR-024) and the hostname.
//   5. Mint the key and the host row in one transaction; the scope and the
//      host reference each other, so the host public id is minted first.
//   6. Sign the claims, sign the initial bundle, and return everything once.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { tachoEnrollmentCreate } from "@oxagen/oxagen/contracts/tacho.enrollment.create";
import {
  type EnrollmentClaims,
  TACHO_ENROLLMENT_CLAIMS_SCHEMA,
} from "@oxagen/oxagen/tacho/schemas";
import { schema, withTenantDb } from "@oxagen/database";
import { cryptoRandom } from "@oxagen/database/schema";
import { emitSecurityEvent } from "@oxagen/database/security";
import { digestBytes } from "@oxagen/tacho";
import { and, eq } from "drizzle-orm";
import {
  API_KEY_AUTHORIZED_ROLES as AUTHORIZED_ROLES,
  resolveActorOrgRole as resolveActorRole,
  generateApiKey,
} from "./lib/api-key-authz";
import { TACHO_HOST_SCOPE_PURPOSE } from "./lib/tacho-enrollment";
import { signTachoEnrollment } from "./lib/tacho-enrollment-signing";
import {
  readDenyGeneration,
  requireBundleSigner,
  signBundle,
  unsignedBundle,
  type TachoHostRow,
} from "./lib/tacho-host";
import { logger } from "./logger";

const SIGNING_SECRET_ENV = "TACHO_ENROLLMENT_SIGNING_SECRET";
const ISSUER = "oxagen";
const AUDIENCE = "tacho-collector";
const CREDENTIAL_ENV = "TACHO_HOST_API_KEY";
const DEFAULT_ENDPOINT = "https://api.oxagen.sh/v1/tacho";

function denied(message: string): CapabilityError {
  return new CapabilityError(
    "create_tacho_enrollment",
    "authz_denied",
    message,
  );
}

/** The machine endpoint bases this deployment serves. HTTPS only. */
export function resolveAllowedEndpoints(): string[] {
  const raw = process.env["TACHO_INGEST_ENDPOINTS"];
  const entries = raw
    ? raw
        .split(",")
        .map((entry) => entry.trim().replace(/\/+$/, ""))
        .filter(Boolean)
    : [DEFAULT_ENDPOINT];
  return entries.filter((entry) => entry.startsWith("https://"));
}

/** `cc-<hostname slug>`, capped at ADR-024's 18-character agent slug. */
export function agentSlugFor(hostname: string): string {
  const slug = hostname
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 15)
    .replace(/-+$/, "");
  return `cc-${slug.length > 0 ? slug : "host"}`;
}

/** The digest of the raw key material, whatever encoding the host chose. */
export function deviceKeyFingerprint(devicePublicKey: string): string {
  const base64 = devicePublicKey.slice("ed25519:".length);
  return digestBytes(Buffer.from(base64, "base64"));
}

export const tachoEnrollmentCreateHandler: CapabilityHandler<
  typeof tachoEnrollmentCreate
> = async (input, ctx) => {
  if (!ctx.userId) throw denied("Unauthorized: no authenticated user");
  if (!ctx.orgId) throw denied("Forbidden: orgId is required");
  if (!ctx.workspaceId) throw denied("Forbidden: workspaceId is required");

  const actorRole = await resolveActorRole(ctx.orgId, ctx.userId);
  if (!actorRole || !AUTHORIZED_ROLES.has(actorRole)) {
    logger.warn(
      { orgId: ctx.orgId, actorRole },
      "tacho.enrollment.create: rejected — insufficient org role",
    );
    throw denied("Forbidden: only org Owners and Admins can enrol Tacho hosts");
  }

  const secret = process.env[SIGNING_SECRET_ENV];
  if (!secret) {
    logger.error(
      {},
      `tacho.enrollment.create: ${SIGNING_SECRET_ENV} is not set — cannot sign an enrollment`,
    );
    throw new Error(
      `Tacho enrollment signing is not configured: ${SIGNING_SECRET_ENV} is unset`,
    );
  }
  const signer = requireBundleSigner("create_tacho_enrollment");

  const allowedEndpoints = resolveAllowedEndpoints();
  const endpointBase = allowedEndpoints[0];
  if (!endpointBase) {
    throw new Error(
      "Tacho enrollment has no HTTPS endpoint to sign: TACHO_INGEST_ENDPOINTS is empty",
    );
  }

  const issuedAt = new Date();
  const expiresAt = new Date(
    issuedAt.getTime() + input.validityDays * 24 * 60 * 60 * 1000,
  );
  const hostEnrollmentId = `tch_${cryptoRandom(22)}`;
  const { rawKey, keyPrefix, keyHash } = generateApiKey();
  const fingerprint = deviceKeyFingerprint(input.devicePublicKey);

  const { host, apiKeyPublicId, agentKey, denyGeneration } = await withTenantDb(
    async (tx) => {
      const org = await tx.query.organizations.findFirst({
        where: eq(schema.organizations.id, ctx.orgId),
        columns: { namespace: true },
      });
      const workspace = await tx.query.workspaces.findFirst({
        where: and(
          eq(schema.workspaces.id, ctx.workspaceId),
          eq(schema.workspaces.orgId, ctx.orgId),
        ),
        columns: { namespace: true },
      });
      if (!org || !workspace) {
        throw denied(
          "Forbidden: organization or workspace namespace not found",
        );
      }
      const baseSlug = agentSlugFor(input.hostname);
      let agentKeyCandidate = `${org.namespace}.${workspace.namespace}.${baseSlug}`;
      const clash = await tx.query.tachoHosts.findFirst({
        where: and(
          eq(schema.tachoHosts.orgId, ctx.orgId),
          eq(schema.tachoHosts.agentKey, agentKeyCandidate),
        ),
        columns: { id: true },
      });
      if (clash) {
        agentKeyCandidate = `${org.namespace}.${workspace.namespace}.${baseSlug.slice(0, 13)}-${cryptoRandom(4)}`;
      }

      const [key] = await tx
        .insert(schema.apiKeys)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          keyPrefix,
          keyHash,
          name: `tacho host ${input.hostname}`,
          scope: {
            purpose: TACHO_HOST_SCOPE_PURPOSE,
            host_enrollment_id: hostEnrollmentId,
          },
          expiresAt,
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .returning({
          id: schema.apiKeys.id,
          publicId: schema.apiKeys.publicId,
        });
      if (!key) {
        throw new Error(
          "Internal error: failed to create the Tacho host API key",
        );
      }

      const claims: EnrollmentClaims = {
        schema: TACHO_ENROLLMENT_CLAIMS_SCHEMA,
        issuer: ISSUER,
        audience: AUDIENCE,
        host_enrollment_id: hostEnrollmentId,
        organization_id: ctx.orgId,
        workspace_id: ctx.workspaceId,
        agent_key: agentKeyCandidate,
        ingest_endpoint: `${endpointBase}/events`,
        bundle_endpoint: `${endpointBase}/bundle`,
        commands_endpoint: `${endpointBase}/commands`,
        credential_env: CREDENTIAL_ENV,
        device_key_fingerprint: fingerprint,
        harnesses: input.harnesses,
        issued_at_unix_s: Math.floor(issuedAt.getTime() / 1000),
        expires_at_unix_s: Math.floor(expiresAt.getTime() / 1000),
      };
      const signatureHex = signTachoEnrollment(claims, secret);

      const [inserted] = await tx
        .insert(schema.tachoHosts)
        .values({
          publicId: hostEnrollmentId,
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          agentKey: agentKeyCandidate,
          apiKeyId: key.id,
          hostname: input.hostname,
          hostnameDigest: digestBytes(input.hostname),
          platform: input.platform,
          osVersion: input.osVersion ?? null,
          arch: input.arch ?? null,
          osUser: input.osUser,
          osUserDigest: digestBytes(input.osUser),
          devicePublicKey: input.devicePublicKey,
          deviceKeyFingerprint: fingerprint,
          harnesses: input.harnesses,
          claudeVersionAtEnroll: input.claudeVersion ?? null,
          claudeExecpath: input.claudeExecpath ?? null,
          nodeVersion: input.nodeVersion ?? null,
          wrapperVersion: input.wrapperVersion ?? null,
          shell: input.shell ?? null,
          status: "active",
          enrollmentClaims: claims,
          enrollmentSignature: signatureHex,
          expiresAt,
          managed: input.managed,
          mode: "observe",
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .returning();
      if (!inserted) {
        throw new Error("Internal error: failed to create the Tacho host");
      }
      const denyGeneration = await readDenyGeneration(
        tx as never,
        ctx.orgId,
        ctx.workspaceId,
      );
      return {
        host: inserted as TachoHostRow,
        apiKeyPublicId: key.publicId,
        agentKey: agentKeyCandidate,
        denyGeneration,
      };
    },
  );

  const bundle = signBundle(
    signer,
    unsignedBundle(host, denyGeneration, issuedAt),
  );

  emitSecurityEvent({
    eventType: "api_key.created",
    actorUserId: ctx.userId,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    capability: "create_tacho_enrollment",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      hostEnrollmentId,
      agentKey,
    },
    "tacho.enrollment.create: host enrolled",
  );

  return {
    hostEnrollmentId,
    agentKey,
    apiKeyPublicId,
    apiKey: rawKey,
    enrollment: {
      claims: host.enrollmentClaims as EnrollmentClaims,
      signature_hex: host.enrollmentSignature,
      verification_secret_env: SIGNING_SECRET_ENV,
    },
    policyBundle: bundle,
    bundlePublicKeyPem: signer.publicKeyPem,
    expiresAt: expiresAt.toISOString(),
  };
};
