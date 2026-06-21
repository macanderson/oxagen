import { z } from "zod";
import { registerConnector, type ConnectorDefinition, type NormalizedRecord, type RecordTypeSample } from "../types";
import { verifyGoogleChannelToken } from "./verify-channel-token";

const connectionConfigSchema = z.object({
  calendarIds: z.array(z.string()).optional(),
  includeDeclinedEvents: z.boolean().default(false),
  syncMonthsBack: z.number().int().positive().default(3),
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

const googleCalendar: ConnectorDefinition<Config> = {
  connectorId: "google-calendar",
  displayName: "Google Calendar",
  description: "Sync events and calendars from Google Calendar.",
  icon: "google-calendar",
  supportedAuthSchemes: ["oauth2_authorization_code"],
  deliveryMethod: "webhook",
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("google-calendar.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);

    switch (sourceRecordType) {
      case "event": {
        const start = asRecord(r["start"]);
        const end = asRecord(r["end"]);
        const organizer = asRecord(r["organizer"]);
        const attendees = asArray(r["attendees"])
          .map((a) => asString(asRecord(a)["email"]))
          .filter(Boolean);
        return {
          externalId: asString(r["id"]) ?? "",
          externalUrl: asString(r["htmlLink"]),
          displayName: asString(r["summary"]),
          properties: {
            summary: asString(r["summary"]),
            description: asString(r["description"]),
            start: asString(start["dateTime"]) ?? asString(start["date"]),
            end: asString(end["dateTime"]) ?? asString(end["date"]),
            attendees,
            location: asString(r["location"]),
            status: asString(r["status"]),
            organizer: asString(organizer["email"]),
            recurringEventId: asString(r["recurringEventId"]),
            createdAt: asString(r["created"]),
            updatedAt: asString(r["updated"]),
          },
        };
      }

      case "calendar": {
        return {
          externalId: asString(r["id"]) ?? "",
          displayName: asString(r["summary"]),
          properties: {
            summary: asString(r["summary"]),
            description: asString(r["description"]),
            timeZone: asString(r["timeZone"]),
            accessRole: asString(r["accessRole"]),
          },
        };
      }

      default:
        throw new Error(`google-calendar.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`);
    }
  },

  // Google Calendar push channels echo the watch `channel.token` back as the
  // X-Goog-Channel-Token header — verify it against the stored channel secret.
  verifyWebhook(_payload, headers, secret): boolean {
    return verifyGoogleChannelToken(headers, secret);
  },
};

registerConnector(googleCalendar);

export { googleCalendar };
