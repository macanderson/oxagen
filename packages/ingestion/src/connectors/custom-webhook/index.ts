import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  registerConnector,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RecordTypeSample,
} from "../types";
import { constantTimeStringEqual } from "../safe-compare";

// The config used to declare `signatureStrategy`, `signatureHeader`,
// `idJsonPath`, `displayNameJsonPath`, and a per-record-type
// `eventTypeJsonPath`, and nothing read them (#1875). A connection set to a
// bearer or static-secret strategy rejected every delivery, and a custom id
// path was ignored. `z.object` strips unknown keys, so a stored config that
// still carries them parses, and they drop out.
const recordTypeDefinitionSchema = z.object({
  sourceRecordType: z.string().min(1),
  // Glob or value that matches this record type against the event type
  matcher: z.string().min(1),
});

const connectionConfigSchema = z.object({
  recordTypes: z.array(recordTypeDefinitionSchema).min(1),
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
    // Generic passthrough. The customer's entity_type_mappings rename fields
    // at Stage 3.
    //
    // normalizeRecord takes no config, so the id and display name come from
    // the fixed key lists below. A source whose id lives under any other key
    // yields the `<type>:unknown` sentinel, and every such record collapses
    // onto one naturalKey.
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

    // HMAC-SHA256 is the one verification this connector performs. The three
    // header names below are tried in order, and the value must be the
    // GitHub-style `sha256=<hex>` digest of the raw body.
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
