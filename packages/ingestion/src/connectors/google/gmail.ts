import { z } from "zod";
import { registerConnector, type ConnectorDefinition, type NormalizedRecord, type RecordTypeSample } from "../types";

const connectionConfigSchema = z.object({
  labelIds: z.array(z.string()).optional(),
  includeSpamTrash: z.boolean().default(false),
  syncDaysBack: z.number().int().positive().default(30),
});

type Config = typeof connectionConfigSchema;

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

const googleGmail: ConnectorDefinition<Config> = {
  connectorId: "google-gmail",
  displayName: "Gmail",
  description: "Sync email threads and messages from Gmail.",
  icon: "gmail",
  supportedAuthSchemes: ["oauth2_authorization_code"],
  deliveryMethod: "webhook",
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("google-gmail.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);

    switch (sourceRecordType) {
      case "thread": {
        const messages = asArray(r["messages"]);
        return {
          externalId: asString(r["id"]) ?? "",
          displayName: asString(r["snippet"])?.slice(0, 100),
          properties: {
            snippet: asString(r["snippet"]),
            historyId: asString(r["historyId"]),
            messageCount: asNumber(r["messagesCount"]) ?? messages.length,
          },
        };
      }

      case "message": {
        const payload = asRecord(r["payload"]);
        const headers = asArray(payload["headers"]);
        const getHeader = (name: string) =>
          asString(
            asRecord(headers.find((h) => asString(asRecord(h)["name"])?.toLowerCase() === name.toLowerCase()))?.[
              "value"
            ],
          );
        return {
          externalId: asString(r["id"]) ?? "",
          displayName: getHeader("subject"),
          properties: {
            subject: getHeader("subject"),
            from: getHeader("from"),
            to: getHeader("to"),
            snippet: asString(r["snippet"]),
            labelIds: asArray(r["labelIds"]).filter((l) => typeof l === "string"),
            date: getHeader("date"),
            threadId: asString(r["threadId"]),
          },
        };
      }

      default:
        throw new Error(`google-gmail.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`);
    }
  },
};

registerConnector(googleGmail);

export { googleGmail };
