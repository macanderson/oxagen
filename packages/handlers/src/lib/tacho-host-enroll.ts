// tacho-host-enroll.ts — the one writer of a tacho.hosts row and of the
// server-owned Tacho host scope (`tacho_host_v1`) on an API key, shared by
// the two ways a machine enrols: an operator session (`create_tacho_enrollment`)
// and a single-use enrollment token (`enroll_host`, #2967). The callers decide
// who is enrolling and as which agent key; this module mints the key, signs
// the claims, writes the host, and assembles the document the collector keeps.
import type { Tx } from "@oxagen/database";
import { schema } from "@oxagen/database";
import { getTableColumns } from "drizzle-orm";
import { cryptoRandom } from "@oxagen/database/schema";
import {
  type EnrollmentClaims,
  TACHO_ENROLLMENT_CLAIMS_SCHEMA,
} from "@oxagen/oxagen/tacho/schemas";
import type { TachoEnrollmentCreateOutput } from "@oxagen/oxagen/contracts/tacho.enrollment.create";
import { digestBytes } from "@oxagen/tacho";
import { generateApiKey } from "./api-key-authz";
import {
  TACHO_GATEWAY_SCOPE_PURPOSE,
  TACHO_HOST_SCOPE_PURPOSE,
} from "./tacho-enrollment";
import { signTachoEnrollment } from "./tacho-enrollment-signing";
import { type BundleSigner } from "./tacho-bundle-signing";
import {
  type DenyGeneration,
  type HostMandate,
  readDenyGeneration,
  readWorkspaceRetention,
  requireBundleSigner,
  resolveHostMandate,
  signBundle,
  type TachoHostRow,
  unsignedBundle,
} from "./tacho-host";
import { hostGatewayColumnReady } from "./tacho-gateway-columns";
import {
  readWorkspaceSteering,
  type WorkspaceSteering,
} from "./tacho-steering";
import { logger } from "../logger";

const TACHO_ENROLLMENT_SIGNING_SECRET_ENV = "TACHO_ENROLLMENT_SIGNING_SECRET";
const ISSUER = "oxagen";
const AUDIENCE = "tacho-collector";
const CREDENTIAL_ENV = "TACHO_HOST_API_KEY";
const DEFAULT_ENDPOINT = "https://api.oxagen.sh/v1/tacho";
/**
 * Where this deployment's workspace MCP endpoint lives, for the claim the
 * host's local gateway dials. Unset means the claim omits it and the host
 * falls back to its own derivation from `api_url`.
 */
const MCP_ENDPOINT_ENV = "TACHO_MCP_ENDPOINT";

/** The signed MCP endpoint, or undefined when this deployment names none. */
function resolveMcpEndpoint(): string | undefined {
  const raw = process.env[MCP_ENDPOINT_ENV];
  return typeof raw === "string" && raw.startsWith("https://")
    ? raw
    : undefined;
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

/** The digest of the raw key material, whatever encoding the host chose. */
export function deviceKeyFingerprint(devicePublicKey: string): string {
  const base64 = devicePublicKey.slice("ed25519:".length);
  return digestBytes(Buffer.from(base64, "base64"));
}

interface EnrollmentSigning {
  secret: string;
  signer: BundleSigner;
  endpointBase: string;
}

/**
 * The signing material an enrollment needs. Missing any of it is a deployment
 * defect; refuse before a row is written rather than mint a document no host
 * could verify.
 */
export function requireEnrollmentSigning(
  capability: string,
): EnrollmentSigning {
  const secret = process.env[TACHO_ENROLLMENT_SIGNING_SECRET_ENV];
  if (!secret) {
    logger.error(
      {},
      `${capability}: ${TACHO_ENROLLMENT_SIGNING_SECRET_ENV} is not set — cannot sign an enrollment`,
    );
    throw new Error(
      `Tacho enrollment signing is not configured: ${TACHO_ENROLLMENT_SIGNING_SECRET_ENV} is unset`,
    );
  }
  const signer = requireBundleSigner(capability);
  const endpointBase = resolveAllowedEndpoints()[0];
  if (!endpointBase) {
    throw new Error(
      "Tacho enrollment has no HTTPS endpoint to sign: TACHO_INGEST_ENDPOINTS is empty",
    );
  }
  return { secret, signer, endpointBase };
}

/** The facts a host reports about itself, as both contracts accept them. */
interface HostFacts {
  hostname: string;
  osUser: string;
  platform: string;
  osVersion?: string | undefined;
  arch?: string | undefined;
  devicePublicKey: string;
  harnesses: EnrollmentClaims["harnesses"];
  claudeVersion?: string | undefined;
  claudeExecpath?: string | undefined;
  nodeVersion?: string | undefined;
  wrapperVersion?: string | undefined;
  /** The bundle fields this host's parser understands; see the contract. */
  bundleFeatures?: string[] | undefined;
  shell?: string | undefined;
  managed: boolean;
  validityDays: number;
}

interface MintHostEnrollmentArgs {
  orgId: string;
  workspaceId: string;
  /** The operator the enrollment is recorded against. */
  userId: string;
  /** `org_ns.ws_ns.slug` (ADR-024), resolved by the caller. */
  agentKey: string;
  /** The registered agent the host reports as; null for an operator enrollment. */
  agent: { id: string; principalId: string | null } | null;
  facts: HostFacts;
  signing: EnrollmentSigning;
  issuedAt: Date;
}

interface MintedHostEnrollment {
  host: TachoHostRow;
  hostEnrollmentId: string;
  apiKeyPublicId: string;
  rawKey: string;
  /** The second credential, for the host's local MCP gateway (ADR-078). */
  gatewayApiKeyPublicId: string;
  gatewayRawKey: string;
  expiresAt: Date;
  denyGeneration: DenyGeneration;
  retention: Awaited<ReturnType<typeof readWorkspaceRetention>>;
  /**
   * The workspace's assembled steering, for the initial bundle: the text and
   * the manifest of what was included or cut (ADR-091, ADR-144).
   */
  steering: WorkspaceSteering;
  /** The host's mandate, for the initial bundle. Empty until `args.agent` names one. */
  mandate: HostMandate;
}

/**
 * Mint the host's API key and its `tacho.hosts` row in the caller's
 * transaction. The scope and the host reference each other, so the host
 * public id is minted first.
 */
export async function mintHostEnrollment(
  tx: Tx,
  args: MintHostEnrollmentArgs,
): Promise<MintedHostEnrollment> {
  const { facts, signing, issuedAt } = args;
  const expiresAt = new Date(
    issuedAt.getTime() + facts.validityDays * 24 * 60 * 60 * 1000,
  );
  const hostEnrollmentId = `tch_${cryptoRandom(22)}`;
  const { rawKey, keyPrefix, keyHash } = generateApiKey();
  // A second credential, for the local MCP gateway (ADR-078). It is separate
  // from the host key on purpose: the host key reports events and fetches its
  // mandate, and the gateway serves tools to a connected app. Those are
  // different jobs with different blast radii, and one credential doing both
  // is what let a connected app inherit the host's authority. The purpose on
  // each is what `machineKeyDenial` constrains them by.
  const gatewayKey = generateApiKey();
  const fingerprint = deviceKeyFingerprint(facts.devicePublicKey);

  const [key] = await tx
    .insert(schema.apiKeys)
    .values({
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      keyPrefix,
      keyHash,
      name: `tacho host ${facts.hostname}`,
      scope: {
        purpose: TACHO_HOST_SCOPE_PURPOSE,
        host_enrollment_id: hostEnrollmentId,
      },
      expiresAt,
      createdById: args.userId,
      updatedById: args.userId,
    })
    .returning({
      id: schema.apiKeys.id,
      publicId: schema.apiKeys.publicId,
    });
  if (!key) {
    throw new Error("Internal error: failed to create the Tacho host API key");
  }

  const [gateway] = await tx
    .insert(schema.apiKeys)
    .values({
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      keyPrefix: gatewayKey.keyPrefix,
      keyHash: gatewayKey.keyHash,
      name: `tacho gateway ${facts.hostname}`,
      scope: {
        purpose: TACHO_GATEWAY_SCOPE_PURPOSE,
        host_enrollment_id: hostEnrollmentId,
      },
      expiresAt,
      createdById: args.userId,
      updatedById: args.userId,
    })
    .returning({
      id: schema.apiKeys.id,
      publicId: schema.apiKeys.publicId,
    });
  if (!gateway) {
    throw new Error(
      "Internal error: failed to create the Tacho gateway API key",
    );
  }

  const mcpEndpoint = resolveMcpEndpoint();
  const claims: EnrollmentClaims = {
    schema: TACHO_ENROLLMENT_CLAIMS_SCHEMA,
    issuer: ISSUER,
    audience: AUDIENCE,
    host_enrollment_id: hostEnrollmentId,
    organization_id: args.orgId,
    workspace_id: args.workspaceId,
    agent_key: args.agentKey,
    ingest_endpoint: `${signing.endpointBase}/events`,
    bundle_endpoint: `${signing.endpointBase}/bundle`,
    commands_endpoint: `${signing.endpointBase}/commands`,
    // Signed rather than derived: the host would otherwise guess it by
    // swapping `api.` for `mcp.` in api_url, which is wrong for any
    // deployment whose MCP host is not named that way.
    ...(mcpEndpoint === undefined ? {} : { mcp_endpoint: mcpEndpoint }),
    credential_env: CREDENTIAL_ENV,
    device_key_fingerprint: fingerprint,
    harnesses: facts.harnesses,
    issued_at_unix_s: Math.floor(issuedAt.getTime() / 1000),
    expires_at_unix_s: Math.floor(expiresAt.getTime() / 1000),
  };
  const signatureHex = signTachoEnrollment(claims, signing.secret);

  // What the INSERT may name in `RETURNING`.
  //
  // A bare `.returning()` asks for every column the schema declares, including
  // `gateway_last_seen_at` — so before migration 20260917140000 is applied, the
  // insert raises 42703 and enrolling a host fails outright for the window
  // between deploy and migration (discussion_r4041098517). The reads were
  // guarded for exactly this and the write side was missed; RETURNING is a
  // read wearing a write's clothes.
  // Typed as the full column map so the returned row keeps `TachoHostRow`,
  // while one key may be absent at runtime — the same shape the projected
  // reads have, and `gatewayObservationFor` already answers `null` for it.
  const hostColumns = getTableColumns(schema.tachoHosts);
  const returning: typeof hostColumns = { ...hostColumns };
  if (!(await hostGatewayColumnReady(tx))) {
    delete (returning as Partial<typeof hostColumns>).gatewayLastSeenAt;
  }

  const [inserted] = await tx
    .insert(schema.tachoHosts)
    .values({
      publicId: hostEnrollmentId,
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      agentKey: args.agentKey,
      agentId: args.agent?.id ?? null,
      agentPrincipalId: args.agent?.principalId ?? null,
      apiKeyId: key.id,
      hostname: facts.hostname,
      hostnameDigest: digestBytes(facts.hostname),
      platform: facts.platform,
      osVersion: facts.osVersion ?? null,
      arch: facts.arch ?? null,
      osUser: facts.osUser,
      osUserDigest: digestBytes(facts.osUser),
      devicePublicKey: facts.devicePublicKey,
      deviceKeyFingerprint: fingerprint,
      harnesses: facts.harnesses,
      claudeVersionAtEnroll: facts.claudeVersion ?? null,
      claudeExecpath: facts.claudeExecpath ?? null,
      nodeVersion: facts.nodeVersion ?? null,
      wrapperVersion: facts.wrapperVersion ?? null,
      // Empty, not null: a client that advertised nothing can parse no gated
      // field, and the initial bundle below is built from this row.
      bundleFeatures: facts.bundleFeatures ?? [],
      shell: facts.shell ?? null,
      status: "active",
      enrollmentClaims: claims,
      enrollmentSignature: signatureHex,
      expiresAt,
      managed: facts.managed,
      mode: "observe",
      createdById: args.userId,
      updatedById: args.userId,
    })
    .returning(returning);
  if (!inserted) {
    throw new Error("Internal error: failed to create the Tacho host");
  }
  const [denyGeneration, retention, steering, mandate] = await Promise.all([
    readDenyGeneration(tx as never, args.orgId, args.workspaceId),
    readWorkspaceRetention(tx as never, args.orgId, args.workspaceId),
    readWorkspaceSteering(tx as never, args.orgId, args.workspaceId),
    resolveHostMandate(
      tx as never,
      { orgId: args.orgId, workspaceId: args.workspaceId },
      inserted as TachoHostRow,
    ),
  ]);
  return {
    host: inserted as TachoHostRow,
    hostEnrollmentId,
    apiKeyPublicId: key.publicId,
    rawKey,
    gatewayApiKeyPublicId: gateway.publicId,
    gatewayRawKey: gatewayKey.rawKey,
    expiresAt,
    denyGeneration,
    retention,
    steering,
    mandate,
  };
}

/** The document the collector keeps: the shown-once key, the signed claims, the signed initial bundle. */
export function enrollmentDocument(
  minted: MintedHostEnrollment,
  signing: EnrollmentSigning,
  issuedAt: Date,
): TachoEnrollmentCreateOutput {
  const bundle = signBundle(
    signing.signer,
    unsignedBundle(
      minted.host,
      minted.denyGeneration,
      minted.retention,
      minted.steering,
      minted.mandate,
      issuedAt,
    ),
  );
  return {
    hostEnrollmentId: minted.hostEnrollmentId,
    agentKey: minted.host.agentKey,
    apiKeyPublicId: minted.apiKeyPublicId,
    apiKey: minted.rawKey,
    gatewayApiKeyPublicId: minted.gatewayApiKeyPublicId,
    gatewayApiKey: minted.gatewayRawKey,
    enrollment: {
      claims: minted.host.enrollmentClaims as EnrollmentClaims,
      signature_hex: minted.host.enrollmentSignature,
      verification_secret_env: TACHO_ENROLLMENT_SIGNING_SECRET_ENV,
    },
    policyBundle: bundle,
    bundlePublicKeyPem: signing.signer.publicKeyPem,
    expiresAt: minted.expiresAt.toISOString(),
  };
}
