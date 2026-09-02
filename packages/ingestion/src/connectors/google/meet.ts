import { z } from "zod";
import {
  registerConnector,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RecordTypeSample,
} from "../types";

const connectionConfigSchema = z.object({
  includeRecordings: z.boolean().default(false),
  includeTranscripts: z.boolean().default(false),
  syncDaysBack: z.number().int().positive().default(30),
});

type Config = typeof connectionConfigSchema;

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object"
    ? (raw as Record<string, unknown>)
    : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

const googleMeet: ConnectorDefinition<Config> = {
  connectorId: "google-meet",
  displayName: "Google Meet",
  description:
    "Sync meeting records, participants, and transcripts from Google Meet.",
  icon: "google-meet",
  supportedAuthSchemes: ["oauth2_authorization_code"],
  deliveryMethod: "rest_polling",
  defaultPollIntervalSeconds: 3600,
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("google-meet.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);

    switch (sourceRecordType) {
      case "conference_record": {
        const participants = asArray(r["participants"]);
        return {
          externalId: asString(r["name"]) ?? "",
          displayName: asString(r["space"]),
          properties: {
            spaceId: asString(r["space"]),
            startTime: asString(r["startTime"]),
            endTime: asString(r["endTime"]),
            participantCount: participants.length,
            expireTime: asString(r["expireTime"]),
          },
        };
      }

      case "participant": {
        const signinUser = asRecord(r["signinUser"]);
        return {
          externalId: asString(r["name"]) ?? "",
          displayName: asString(signinUser["displayName"]),
          properties: {
            displayName: asString(signinUser["displayName"]),
            email: asString(signinUser["user"]),
            earliestStartTime: asString(r["earliestStartTime"]),
            latestEndTime: asString(r["latestEndTime"]),
          },
        };
      }

      case "transcript": {
        return {
          externalId: asString(r["name"]) ?? "",
          displayName: "Meeting transcript",
          properties: {
            conferenceRecord: asString(r["conferenceRecord"]),
            startTime: asString(r["startTime"]),
            endTime: asString(r["endTime"]),
            state: asString(r["state"]),
            docsDestination: asString(
              asRecord(r["docsDestination"])["document"],
            ),
          },
        };
      }

      default:
        throw new Error(
          `google-meet.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`,
        );
    }
  },
};

registerConnector(googleMeet);

export { googleMeet };
