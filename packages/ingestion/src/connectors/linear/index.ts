import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { registerConnector, type ConnectorDefinition, type NormalizedRecord, type RecordTypeSample } from "../types";

const connectionConfigSchema = z.object({
  teamIds: z.array(z.string()).optional(),
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

const linear: ConnectorDefinition<Config> = {
  connectorId: "linear",
  displayName: "Linear",
  description: "Sync issues, projects, cycles, and milestones from Linear.",
  icon: "linear",
  supportedAuthSchemes: ["oauth2_authorization_code", "api_key"],
  deliveryMethod: "webhook",
  defaultPollIntervalSeconds: 900,
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("linear.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);

    switch (sourceRecordType) {
      case "issue": {
        const state = asRecord(r["state"]);
        const assignee = asRecord(r["assignee"]);
        const labels = asArray(r["labels"]).map((l) => asString(asRecord(l)["name"])).filter(Boolean);
        return {
          externalId: asString(r["id"]) ?? "",
          externalUrl: asString(r["url"]),
          displayName: asString(r["title"]),
          properties: {
            title: asString(r["title"]),
            description: asString(r["description"]),
            state: asString(state["name"]),
            priority: r["priority"],
            assignee: asString(assignee["name"]),
            assigneeEmail: asString(assignee["email"]),
            labels,
            url: asString(r["url"]),
            identifier: asString(r["identifier"]),
            estimate: r["estimate"],
            dueDate: asString(r["dueDate"]),
            createdAt: asString(r["createdAt"]),
            updatedAt: asString(r["updatedAt"]),
          },
        };
      }

      case "project": {
        const lead = asRecord(r["lead"]);
        return {
          externalId: asString(r["id"]) ?? "",
          externalUrl: asString(r["url"]),
          displayName: asString(r["name"]),
          properties: {
            name: asString(r["name"]),
            description: asString(r["description"]),
            state: asString(r["state"]),
            lead: asString(lead["name"]),
            progress: r["progress"],
            startDate: asString(r["startDate"]),
            targetDate: asString(r["targetDate"]),
            url: asString(r["url"]),
            createdAt: asString(r["createdAt"]),
            updatedAt: asString(r["updatedAt"]),
          },
        };
      }

      case "cycle": {
        return {
          externalId: asString(r["id"]) ?? "",
          externalUrl: asString(r["url"]),
          displayName: asString(r["name"]) ?? `Cycle ${r["number"]}`,
          properties: {
            name: asString(r["name"]),
            number: r["number"],
            startsAt: asString(r["startsAt"]),
            endsAt: asString(r["endsAt"]),
            completedAt: asString(r["completedAt"]),
            progress: r["progress"],
            url: asString(r["url"]),
          },
        };
      }

      case "comment": {
        const user = asRecord(r["user"]);
        return {
          externalId: asString(r["id"]) ?? "",
          displayName: asString(r["body"])?.slice(0, 100),
          properties: {
            body: asString(r["body"]),
            author: asString(user["name"]),
            authorEmail: asString(user["email"]),
            createdAt: asString(r["createdAt"]),
            updatedAt: asString(r["updatedAt"]),
          },
        };
      }

      default:
        throw new Error(`linear.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`);
    }
  },

  verifyWebhook(payload, headers, secret): boolean {
    if (!secret) return false;
    const sig = headers["linear-signature"];
    if (!sig) return false;
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  },
};

registerConnector(linear);

export { linear };
