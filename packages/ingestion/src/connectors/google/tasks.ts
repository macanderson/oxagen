import { z } from "zod";
import {
  registerConnector,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RecordTypeSample,
} from "../types";

const connectionConfigSchema = z.object({
  taskListIds: z.array(z.string()).optional(),
  includeCompleted: z.boolean().default(true),
  syncDaysBack: z.number().int().positive().default(90),
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

const googleTasks: ConnectorDefinition<Config> = {
  connectorId: "google-tasks",
  displayName: "Google Tasks",
  description: "Sync tasks and task lists from Google Tasks.",
  icon: "google-tasks",
  supportedAuthSchemes: ["oauth2_authorization_code"],
  deliveryMethod: "rest_polling",
  defaultPollIntervalSeconds: 900,
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("google-tasks.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);

    switch (sourceRecordType) {
      case "task": {
        return {
          externalId: asString(r["id"]) ?? "",
          displayName: asString(r["title"]),
          properties: {
            title: asString(r["title"]),
            notes: asString(r["notes"]),
            status: asString(r["status"]),
            due: asString(r["due"]),
            completed: asString(r["completed"]),
            deleted: r["deleted"],
            hidden: r["hidden"],
            taskListId: asString(r["selfLink"])?.match(
              /tasks\/([^/]+)\/tasks/,
            )?.[1],
            updatedAt: asString(r["updated"]),
          },
        };
      }

      case "task_list": {
        return {
          externalId: asString(r["id"]) ?? "",
          displayName: asString(r["title"]),
          properties: {
            title: asString(r["title"]),
            updatedAt: asString(r["updated"]),
          },
        };
      }

      default:
        throw new Error(
          `google-tasks.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`,
        );
    }
  },
};

registerConnector(googleTasks);

export { googleTasks };
