/**
 * The messages between the cloud gateway and the local gateway for local
 * servers (mcp-studio-spec, Local servers and Registry packages).
 *
 * The cloud gateway hands the local gateway a delivery: a call with its
 * signed local-call-envelope/v1, or a request to list a server's tools. The
 * local gateway answers each one with a reply. Neither side keeps a decision
 * the other made.
 *
 * `@oxagen/tacho` is a leaf package with no `@oxagen/*` runtime dependency,
 * so the envelope's schema here copies lane M0's
 * `localCallEnvelopeSchema` (packages/mcp-studio/src/contract/local-call-envelope.ts).
 * The cloud gateway validates every envelope against M0's schema before it
 * signs it, and a handlers test checks that this copy accepts what M0's
 * schema accepts.
 */
import { z } from "zod";
import { digestJcs, jcs, SHA256_DIGEST_PATTERN, type JsonValue, type Sha256Digest } from "../../digest";
import { LOCAL_SERVER_ERROR_CODES } from "./errors";

export const LOCAL_CALL_ENVELOPE_SCHEMA = "local-call-envelope/v1";

/** The longest an envelope may live, as M0's `ENVELOPE_TTL_MAX_MS` sets it. */
export const ENVELOPE_TTL_MAX_MS = 30_000;

/** How long a call runs when its envelope names no deadline_ms. */
export const DEFAULT_DEADLINE_MS = 30_000;

const sha256Schema = z.string().regex(SHA256_DIGEST_PATTERN, "not a sha256:<hex> digest");

/** tacho.hosts' public id, which enrollment writes to the host file as host_enrollment_id. */
export const machineIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "not a machine id");

export const nonceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22,64}$/, "a nonce is 22 to 64 base64url characters");

export const envVarNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "not an environment variable name");

/** A machine group an admin made in Oxagen, as server.toml's source.machines names it. */
export const machineGroupSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "a machine group is lowercase letters, digits, and hyphens");

export const REGISTRY_TYPES = ["npm", "pypi", "oci", "nuget"] as const;
export type RegistryType = (typeof REGISTRY_TYPES)[number];

const instantSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "not an RFC 3339 instant");

export const envelopeSignatureSchema = z
  .object({
    key_id: z.string().regex(/^[0-9a-f]{16}$/, "a key id is 16 lowercase hex characters"),
    alg: z.literal("ed25519"),
    sig: z
      .string()
      .regex(/^[A-Za-z0-9+/]{86}==$/, "an Ed25519 signature is 64 bytes in padded base64"),
  })
  .strict();
export type EnvelopeSignature = z.output<typeof envelopeSignatureSchema>;

/** local-call-envelope/v1, as the local gateway reads it. */
export const localCallEnvelopeSchema = z
  .object({
    schema: z.literal(LOCAL_CALL_ENVELOPE_SCHEMA),
    tool: z.string().min(1).max(256),
    upstream: z.string().min(1).max(256),
    version: z.number().int().min(1),
    definition_hash: sha256Schema,
    package_digest: sha256Schema,
    arguments_hash: sha256Schema,
    deadline_ms: z.number().int().min(1).max(300_000).optional(),
    machine: machineIdSchema,
    nonce: nonceSchema,
    issued_at: instantSchema,
    expires_at: instantSchema,
    signature: envelopeSignatureSchema,
  })
  .strict();
export type LocalCallEnvelope = z.output<typeof localCallEnvelopeSchema>;

/**
 * The package the lock pins: its name, version, and digest. A registry
 * package also names its registry_type. A local server's package has none.
 */
export const launchPackageSchema = z
  .object({
    name: z.string().min(1).max(214),
    version: z.string().min(1).max(64),
    digest: sha256Schema,
    registry_type: z.enum(REGISTRY_TYPES).optional(),
  })
  .strict();
export type LaunchPackage = z.output<typeof launchPackageSchema>;

/**
 * How the local gateway starts one server. For a registry package, command
 * and args are the lock's, and args keep each ${NAME} for the machine to
 * fill. For a local server, command is the lock's and args are server.toml's.
 * args holds up to 1024 entries, the lock's limit for a registry package.
 * env is source.env: the only variables the server receives from the machine.
 */
export const launchSpecSchema = z
  .object({
    server: z.string().min(1).max(128),
    command: z.string().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(1024),
    env: z.array(envVarNameSchema).max(128),
    package: launchPackageSchema,
  })
  .strict();
export type LaunchSpec = z.output<typeof launchSpecSchema>;

/** A call the cloud gateway decided and signed. Its id is the envelope's nonce. */
export const callDeliverySchema = z
  .object({
    kind: z.literal("call"),
    envelope: localCallEnvelopeSchema,
    /** The upstream arguments, which must hash to the envelope's arguments_hash. */
    arguments: z.record(z.unknown()),
    launch: launchSpecSchema,
  })
  .strict();
export type CallDelivery = z.output<typeof callDeliverySchema>;

/** A request to list a server's tools, for discovery (lane M10). */
export const discoverDeliverySchema = z
  .object({
    kind: z.literal("discover"),
    id: nonceSchema,
    launch: launchSpecSchema,
    deadline_ms: z.number().int().min(1).max(300_000),
  })
  .strict();
export type DiscoverDelivery = z.output<typeof discoverDeliverySchema>;

export const deliverySchema = z.discriminatedUnion("kind", [
  callDeliverySchema,
  discoverDeliverySchema,
]);
export type Delivery = z.output<typeof deliverySchema>;

/** The id a reply names: the envelope's nonce for a call, the request's id for discovery. */
export function deliveryId(delivery: Delivery): string {
  return delivery.kind === "call" ? delivery.envelope.nonce : delivery.id;
}

/** An MCP tools/call result (MCP 2025-06-18), as mcp-studio's Transport returns it. */
export const callToolResultSchema = z.object({
  content: z.array(z.object({ type: z.string().min(1) }).passthrough()),
  structuredContent: z.record(z.unknown()).optional(),
  isError: z.boolean().optional(),
});
export type CallToolResult = z.output<typeof callToolResultSchema>;

/** One tool from an MCP tools/list result. */
export const mcpToolSchema = z
  .object({
    name: z.string().min(1).max(256),
    inputSchema: z.record(z.unknown()),
  })
  .passthrough();
export type McpTool = z.output<typeof mcpToolSchema>;

export const refusalSchema = z
  .object({
    code: z.enum(LOCAL_SERVER_ERROR_CODES),
    message: z.string().min(1).max(2048),
    fix: z.string().min(1).max(2048),
  })
  .strict();

/** A call's result, after the local gateway's sensitive-data screen. */
export const resultReplySchema = z
  .object({
    kind: z.literal("result"),
    id: nonceSchema,
    machine: machineIdSchema,
    result: callToolResultSchema,
    /** How many values the screen replaced with a redaction marker. */
    redactions: z.number().int().min(0),
  })
  .strict();

/** A call or a discovery the local gateway refused or could not finish. */
export const refusedReplySchema = z
  .object({
    kind: z.literal("refused"),
    id: nonceSchema,
    machine: machineIdSchema,
    refusal: refusalSchema,
  })
  .strict();

/** A server's tools/list, from the machine that ran it. The sync PR names the machine. */
export const toolsReplySchema = z
  .object({
    kind: z.literal("tools"),
    id: nonceSchema,
    machine: machineIdSchema,
    server: z.string().min(1).max(128),
    /** The version the server reported in initialize, when it reported one. */
    server_version: z.string().min(1).max(64).optional(),
    tools: z.array(mcpToolSchema),
    reported_at: instantSchema,
  })
  .strict();

export const replySchema = z.discriminatedUnion("kind", [
  resultReplySchema,
  refusedReplySchema,
  toolsReplySchema,
]);
export type Reply = z.output<typeof replySchema>;
export type ResultReply = z.output<typeof resultReplySchema>;
export type RefusedReply = z.output<typeof refusedReplySchema>;
export type ToolsReply = z.output<typeof toolsReplySchema>;

/** A value as JSON data: what the wire carries, with undefined members dropped. */
function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** SHA-256 over the RFC 8785 form of the upstream arguments: the envelope's arguments_hash. */
export function argumentsHashOf(args: Record<string, unknown>): Sha256Digest {
  return digestJcs(asJson(args));
}

/** The bytes the cloud gateway signs: the envelope's RFC 8785 form without `signature`. */
export function envelopeSigningBytes(envelope: Record<string, unknown>): Uint8Array {
  const { signature: _signature, ...signed } = envelope;
  return new TextEncoder().encode(jcs(asJson(signed)));
}
