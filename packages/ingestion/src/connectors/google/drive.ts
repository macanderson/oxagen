import { z } from "zod";
import { registerConnector, type ConnectorDefinition, type NormalizedRecord, type RecordTypeSample } from "../types";
import { verifyGoogleChannelToken } from "./verify-channel-token";

const connectionConfigSchema = z.object({
  sharedDrivesOnly: z.boolean().default(false),
  includedMimeTypes: z.array(z.string()).optional(),
});

type Config = typeof connectionConfigSchema;

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

const googleDrive: ConnectorDefinition<Config> = {
  connectorId: "google-drive",
  displayName: "Google Drive",
  description: "Sync files, folders, and shared drives from Google Drive.",
  icon: "google-drive",
  supportedAuthSchemes: ["oauth2_authorization_code"],
  deliveryMethod: "webhook",
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("google-drive.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);

    switch (sourceRecordType) {
      case "file": {
        const owners = asArray(r["owners"])
          .map((o) => asString(asRecord(o)["emailAddress"]))
          .filter(Boolean);
        return {
          externalId: asString(r["id"]) ?? "",
          externalUrl: asString(r["webViewLink"]),
          displayName: asString(r["name"]),
          properties: {
            name: asString(r["name"]),
            mimeType: asString(r["mimeType"]),
            webViewLink: asString(r["webViewLink"]),
            size: asString(r["size"]),
            owners,
            createdTime: asString(r["createdTime"]),
            modifiedTime: asString(r["modifiedTime"]),
            trashed: r["trashed"],
            driveId: asString(r["driveId"]),
          },
        };
      }

      case "folder": {
        const owners = asArray(r["owners"])
          .map((o) => asString(asRecord(o)["emailAddress"]))
          .filter(Boolean);
        return {
          externalId: asString(r["id"]) ?? "",
          externalUrl: asString(r["webViewLink"]),
          displayName: asString(r["name"]),
          properties: {
            name: asString(r["name"]),
            webViewLink: asString(r["webViewLink"]),
            owners,
            createdTime: asString(r["createdTime"]),
            modifiedTime: asString(r["modifiedTime"]),
          },
        };
      }

      case "shared_drive": {
        return {
          externalId: asString(r["id"]) ?? "",
          displayName: asString(r["name"]),
          properties: {
            name: asString(r["name"]),
            createdTime: asString(r["createdTime"]),
          },
        };
      }

      default:
        throw new Error(`google-drive.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`);
    }
  },

  // Google Drive push channels echo the watch `channel.token` back as the
  // X-Goog-Channel-Token header — verify it against the stored channel secret.
  verifyWebhook(_payload, headers, secret): boolean {
    return verifyGoogleChannelToken(headers, secret);
  },
};

registerConnector(googleDrive);

export { googleDrive };
