import { z } from "zod";
import {
  registerConnector,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RecordTypeSample,
} from "../types";
import { constantTimeStringEqual } from "../safe-compare";

const connectionConfigSchema = z.object({
  includePastMeetings: z.boolean().default(true),
  includeRecordings: z.boolean().default(false),
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

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

const zoom: ConnectorDefinition<Config> = {
  connectorId: "zoom",
  displayName: "Zoom",
  description:
    "Sync meetings, recordings, participants, and transcripts from Zoom.",
  icon: "zoom",
  supportedAuthSchemes: ["oauth2_authorization_code"],
  deliveryMethod: "webhook",
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("zoom.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);

    switch (sourceRecordType) {
      case "meeting": {
        const id =
          asNumber(r["id"]) ?? asString(r["id"]) ?? asString(r["uuid"]) ?? "";
        return {
          externalId: String(id),
          displayName: asString(r["topic"]),
          properties: {
            topic: asString(r["topic"]),
            startTime: asString(r["start_time"]),
            duration: asNumber(r["duration"]),
            hostEmail: asString(r["host_email"]),
            joinUrl: asString(r["join_url"]),
            status: asString(r["status"]),
            type: asNumber(r["type"]),
            timezone: asString(r["timezone"]),
            agenda: asString(r["agenda"]),
            uuid: asString(r["uuid"]),
          },
        };
      }

      case "recording": {
        const recordingFiles = asArray(r["recording_files"]);
        return {
          externalId: asString(r["uuid"]) ?? asString(r["id"]) ?? "",
          displayName: asString(r["topic"]),
          properties: {
            topic: asString(r["topic"]),
            startTime: asString(r["start_time"]),
            duration: asNumber(r["duration"]),
            hostEmail: asString(r["host_email"]),
            fileCount: recordingFiles.length,
            totalSize: asNumber(r["total_size"]),
            shareUrl: asString(r["share_url"]),
          },
        };
      }

      case "participant": {
        return {
          externalId: asString(r["id"]) ?? asString(r["user_id"]) ?? "",
          displayName: asString(r["name"]),
          properties: {
            name: asString(r["name"]),
            email: asString(r["user_email"]),
            joinTime: asString(r["join_time"]),
            leaveTime: asString(r["leave_time"]),
            duration: asNumber(r["duration"]),
            attentiveness: asNumber(r["attentiveness_score"]),
          },
        };
      }

      case "transcript": {
        return {
          externalId: asString(r["meeting_id"]) ?? asString(r["uuid"]) ?? "",
          displayName: `Transcript: ${asString(r["topic"]) ?? "meeting"}`,
          properties: {
            meetingId: asString(r["meeting_id"]),
            startTime: asString(r["start_time"]),
            downloadUrl: asString(r["download_url"]),
            fileSize: asNumber(r["file_size"]),
          },
        };
      }

      default:
        throw new Error(
          `zoom.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`,
        );
    }
  },

  // Zoom sends Authorization: <token> as a static bearer token for webhook
  // verification. Compare in constant time — a plain `===` here leaks the
  // secret via response-time analysis on this unauthenticated route.
  verifyWebhook(_payload, headers, secret): boolean {
    if (!secret) return false;
    const auth = headers["authorization"];
    if (!auth) return false;
    return constantTimeStringEqual(auth, secret);
  },
};

registerConnector(zoom);

export { zoom };
