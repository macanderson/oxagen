import { z } from "zod";
import { registerConnector, type ConnectorDefinition, type NormalizedRecord, type RecordTypeSample } from "../types";

const connectionConfigSchema = z.object({
  tenantId: z.string(),
  services: z
    .array(z.enum(["outlook", "teams", "sharepoint", "onedrive", "calendar"]))
    .default(["outlook", "teams"]),
  syncDepthDays: z.number().int().positive().default(90),
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

const microsoft: ConnectorDefinition<Config> = {
  connectorId: "microsoft",
  displayName: "Microsoft 365",
  description:
    "Sync emails, Teams messages, SharePoint files, OneDrive documents, and calendar events from Microsoft 365.",
  icon: "microsoft",
  // Application permissions + admin consent, not delegated
  supportedAuthSchemes: ["oauth2_client_credentials"],
  deliveryMethod: "webhook",
  defaultPollIntervalSeconds: 900,
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("microsoft.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);

    switch (sourceRecordType) {
      case "outlook_message":
      case "email": {
        const from = asRecord(asRecord(r["from"])["emailAddress"]);
        const toRecipients = asArray(r["toRecipients"])
          .map((t) => asString(asRecord(asRecord(t)["emailAddress"])["address"]))
          .filter(Boolean);
        return {
          externalId: asString(r["id"]) ?? "",
          displayName: asString(r["subject"]),
          properties: {
            subject: asString(r["subject"]),
            fromName: asString(from["name"]),
            fromEmail: asString(from["address"]),
            toRecipients,
            bodyPreview: asString(r["bodyPreview"]),
            importance: asString(r["importance"]),
            isRead: r["isRead"],
            hasAttachments: r["hasAttachments"],
            sentDateTime: asString(r["sentDateTime"]),
            receivedDateTime: asString(r["receivedDateTime"]),
            webLink: asString(r["webLink"]),
          },
        };
      }

      case "teams_message": {
        const fromUser = asRecord(asRecord(r["from"])["user"]);
        return {
          externalId: asString(r["id"]) ?? "",
          displayName: asString(r["summary"]) ?? asString(asRecord(r["body"])["content"])?.slice(0, 100),
          properties: {
            body: asString(asRecord(r["body"])["content"]),
            fromUserId: asString(fromUser["id"]),
            fromUserName: asString(fromUser["displayName"]),
            channelId: asString(r["channelIdentity"]),
            messageType: asString(r["messageType"]),
            importance: asString(r["importance"]),
            replyToId: asString(r["replyToId"]),
            createdDateTime: asString(r["createdDateTime"]),
            lastModifiedDateTime: asString(r["lastModifiedDateTime"]),
            webUrl: asString(r["webUrl"]),
          },
        };
      }

      case "sharepoint_file":
      case "onedrive_file": {
        const createdBy = asRecord(asRecord(r["createdBy"])["user"]);
        const lastModifiedBy = asRecord(asRecord(r["lastModifiedBy"])["user"]);
        return {
          externalId: asString(r["id"]) ?? "",
          externalUrl: asString(r["webUrl"]),
          displayName: asString(r["name"]),
          properties: {
            name: asString(r["name"]),
            size: r["size"],
            mimeType: asString(asRecord(r["file"])["mimeType"]),
            createdBy: asString(createdBy["displayName"]),
            lastModifiedBy: asString(lastModifiedBy["displayName"]),
            createdDateTime: asString(r["createdDateTime"]),
            lastModifiedDateTime: asString(r["lastModifiedDateTime"]),
            webUrl: asString(r["webUrl"]),
            downloadUrl: asString(r["@microsoft.graph.downloadUrl"]),
          },
        };
      }

      case "calendar_event": {
        const organizer = asRecord(asRecord(r["organizer"])["emailAddress"]);
        const attendees = asArray(r["attendees"])
          .map((a) => asString(asRecord(asRecord(a)["emailAddress"])["address"]))
          .filter(Boolean);
        return {
          externalId: asString(r["id"]) ?? "",
          externalUrl: asString(r["webLink"]),
          displayName: asString(r["subject"]),
          properties: {
            subject: asString(r["subject"]),
            organizer: asString(organizer["address"]),
            attendees,
            start: asString(asRecord(r["start"])["dateTime"]),
            end: asString(asRecord(r["end"])["dateTime"]),
            location: asString(asRecord(r["location"])["displayName"]),
            isOnlineMeeting: r["isOnlineMeeting"],
            onlineMeetingUrl: asString(r["onlineMeetingUrl"]),
            bodyPreview: asString(r["bodyPreview"]),
            webLink: asString(r["webLink"]),
          },
        };
      }

      default:
        throw new Error(`microsoft.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`);
    }
  },

  verifyWebhook(payload, _headers, secret): boolean {
    // MS Graph lifecycle notifications carry a `clientState` field in the JSON
    // body. We set clientState = the webhook secret at subscription time, so we
    // verify by parsing the notification body and confirming every notification
    // entry's clientState matches the stored secret.
    //
    // The `validationToken` handshake (one-time subscription lifecycle) is
    // handled at the route layer before verifyWebhook is called — it never
    // reaches here.
    if (secret == null) return false;

    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(payload).toString("utf8"));
    } catch {
      return false;
    }

    if (
      body === null ||
      typeof body !== "object" ||
      !Array.isArray((body as Record<string, unknown>)["value"])
    ) {
      return false;
    }

    const notifications = (body as Record<string, unknown>)["value"] as unknown[];
    if (notifications.length === 0) return false;

    return notifications.every((n) => {
      if (n === null || typeof n !== "object") return false;
      const clientState = (n as Record<string, unknown>)["clientState"];
      return typeof clientState === "string" && clientState === secret;
    });
  },
};

registerConnector(microsoft);

export { microsoft };
