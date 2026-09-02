import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  registerConnector,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RecordTypeSample,
} from "../types";
import { constantTimeStringEqual } from "../safe-compare";

const recordTypeDefinitionSchema = z.object({
  sourceRecordType: z.string().min(1),
  // JSONPath to extract the event type from the payload (e.g. "$.event")
  eventTypeJsonPath: z.string().default("$.event"),
  // Glob or value that matches this record type against the extracted event type
  matcher: z.string().min(1),
});

const connectionConfigSchema = z.object({
  recordTypes: z.array(recordTypeDefinitionSchema).min(1),
  signatureStrategy: z
    .enum([
      "none",
      "hmac_sha256_header",
      "bearer_token_header",
      "static_secret_body",
    ])
    .default("hmac_sha256_header"),
  // Header name for the HMAC signature (default: "x-signature")
  signatureHeader: z.string().optional(),
  // JSONPath to a stable externalId in the payload
  idJsonPath: z.string().default("$.id"),
  // JSONPath to a display name in the payload
  displayNameJsonPath: z.string().optional(),
});

type Config = typeof connectionConfigSchema;

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object"
    ? (raw as Record<string, unknown>)
    : {};
}

const customWebhook: ConnectorDefinition<Config> = {
  connectorId: "custom-webhook",
  displayName: "Generic Webhook",
  description: "Receive and ingest events from any HTTP webhook source.",
  icon: "webhook",
  supportedAuthSchemes: ["bearer_token", "api_key", "public"],
  deliveryMethod: "webhook",
  connectionConfigSchema,

  async previewRecordTypes(_auth, config): Promise<RecordTypeSample[]> {
    return config.recordTypes.map((rt) => ({
      sourceRecordType: rt.sourceRecordType,
      displayName: rt.sourceRecordType,
      sampleRecords: [],
      fieldSchema: {},
    }));
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);
    // Generic passthrough — customer's entity_type_mappings rename fields at Stage 3.
    //
    // The configured JSONPaths (`idJsonPath`, `displayNameJsonPath`) are NOT
    // read: normalizeRecord takes no config, so extraction falls back to the
    // fixed key list below. A source whose id lives anywhere else yields the
    // `<type>:unknown` sentinel, and every such record collapses onto one
    // naturalKey — one graph node holding a mix of unrelated records.
    const id = r["id"] ?? r["ID"] ?? r["_id"] ?? r["externalId"];
    const displayName =
      r["name"] ?? r["title"] ?? r["display_name"] ?? r["summary"];
    return {
      externalId: id != null ? String(id) : `${sourceRecordType}:unknown`,
      displayName: displayName != null ? String(displayName) : undefined,
      properties: { sourceRecordType, ...r },
    };
  },

  verifyWebhook(payload, headers, secret): boolean {
    // Fail closed: an unsigned webhook is rejected. A custom-webhook connection
    // must have a signing secret configured; without one we cannot authenticate
    // the sender, so we refuse the delivery rather than ingest arbitrary input.
    if (!secret) return false;

    // Only the `hmac_sha256_header` strategy is actually implemented: the three
    // header names below are tried in order and the value must be the
    // GitHub-style `sha256=<hex>` digest of the raw body. The connection's
    // configured `signatureStrategy` / `signatureHeader` are NOT consulted —
    // verifyWebhook does not receive the connection config — so a connection
    // configured for `bearer_token_header` or `static_secret_body` rejects every
    // delivery.
    const candidateHeaders = [
      "x-signature",
      "x-webhook-signature",
      "x-hub-signature-256",
    ];
    const sig = candidateHeaders.map((h) => headers[h]).find(Boolean);
    if (!sig) return false;

    const expected =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    return constantTimeStringEqual(sig, expected);
  },
};

registerConnector(customWebhook);

export { customWebhook };
