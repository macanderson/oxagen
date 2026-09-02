import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  registerConnector,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RecordTypeSample,
} from "../types";
import { constantTimeStringEqual } from "../safe-compare";

const connectionConfigSchema = z.object({
  channelIds: z.array(z.string()).optional(),
  includeDirectMessages: z.boolean().default(false),
  syncDepthDays: z.number().int().positive().default(90),
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

const slack: ConnectorDefinition<Config> = {
  connectorId: "slack",
  displayName: "Slack",
  description:
    "Sync messages, threads, channels, and user activity from Slack.",
  icon: "slack",
  supportedAuthSchemes: ["oauth2_authorization_code"],
  deliveryMethod: "webhook",
  defaultPollIntervalSeconds: 900,
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("slack.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);

    switch (sourceRecordType) {
      case "message": {
        const reactions = asArray(r["reactions"])
          .map((rx) => asString(asRecord(rx)["name"]))
          .filter(Boolean);
        return {
          externalId: `${r["channel"]}:${r["ts"]}`,
          externalUrl: asString(r["permalink"]),
          displayName: asString(r["text"])?.slice(0, 100),
          properties: {
            text: asString(r["text"]),
            userId: asString(r["user"]),
            channelId: asString(r["channel"]),
            ts: asString(r["ts"]),
            threadTs: asString(r["thread_ts"]),
            replyCount: r["reply_count"],
            reactions,
            hasFiles: asArray(r["files"]).length > 0,
            permalink: asString(r["permalink"]),
          },
        };
      }

      case "channel": {
        const purpose = asRecord(r["purpose"]);
        const topic = asRecord(r["topic"]);
        return {
          externalId: asString(r["id"]) ?? "",
          displayName: asString(r["name"]),
          properties: {
            name: asString(r["name"]),
            purpose: asString(purpose["value"]),
            topic: asString(topic["value"]),
            isPrivate: r["is_private"],
            isArchived: r["is_archived"],
            memberCount: r["num_members"],
            createdAt: r["created"],
          },
        };
      }

      case "user": {
        const profile = asRecord(r["profile"]);
        return {
          externalId: asString(r["id"]) ?? "",
          displayName:
            asString(profile["real_name"]) ?? asString(profile["display_name"]),
          properties: {
            realName: asString(profile["real_name"]),
            displayName: asString(profile["display_name"]),
            email: asString(profile["email"]),
            title: asString(profile["title"]),
            isAdmin: r["is_admin"],
            isBot: r["is_bot"],
            tz: asString(r["tz"]),
          },
        };
      }

      default:
        throw new Error(
          `slack.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`,
        );
    }
  },

  verifyWebhook(payload, headers, secret): boolean {
    if (!secret) return false;
    const timestamp = headers["x-slack-request-timestamp"];
    const sig = headers["x-slack-signature"];
    if (!timestamp || !sig) return false;
    // Reject replays older than 5 minutes. A non-numeric timestamp parses to
    // NaN, and every NaN comparison is false — so it must be rejected
    // explicitly or the replay window silently stops applying.
    const sentAtSeconds = Number(timestamp);
    if (!Number.isFinite(sentAtSeconds)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - sentAtSeconds) > 300)
      return false;
    const baseString = `v0:${timestamp}:${Buffer.from(payload).toString("utf8")}`;
    const expected =
      "v0=" + createHmac("sha256", secret).update(baseString).digest("hex");
    return constantTimeStringEqual(sig, expected);
  },
};

registerConnector(slack);

export { slack };
