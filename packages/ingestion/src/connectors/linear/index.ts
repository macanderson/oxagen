import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  registerConnector,
  type AuthCredential,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RawRecord,
  type RecordTypeSample,
} from "../types";
import { constantTimeStringEqual } from "../safe-compare";

const connectionConfigSchema = z.object({
  teamIds: z.array(z.string()).optional(),
  syncDepthDays: z.number().int().positive().default(90),
});

type Config = typeof connectionConfigSchema;

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/**
 * Linear auth header. OAuth access tokens use `Bearer <token>`; personal API
 * keys are sent raw. The credential resolver maps org/connection OAuth to
 * bearer_token and stored keys to api_key, so both reach here in usable form.
 */
function linearAuthHeader(auth: AuthCredential): string | null {
  if (auth.scheme === "bearer_token") return `Bearer ${auth.token}`;
  if (auth.scheme === "api_key") return auth.apiKey;
  return null;
}

// Per-record-type GraphQL connection + node selection. Each top-level Linear
// connection supports `filter: { updatedAt: { gt } }` and `orderBy: updatedAt`,
// so one shape drives incremental polling for every type.
const NODE_SELECTIONS: Record<string, string> = {
  issue: `id identifier title description priority estimate dueDate url createdAt updatedAt
          state { name } assignee { name email } labels { nodes { name } }`,
  project: `id name description state progress startDate targetDate url createdAt updatedAt
            lead { name }`,
  cycle: `id name number startsAt endsAt completedAt progress url updatedAt`,
  comment: `id body createdAt updatedAt user { name email }`,
};

const QUERY_FIELD: Record<string, string> = {
  issue: "issues",
  project: "projects",
  cycle: "cycles",
  comment: "comments",
};

/** Reshape a GraphQL node into the flat shape normalizeRecord expects. */
function reshapeLinearNode(
  recordType: string,
  node: Record<string, unknown>,
): unknown {
  if (recordType === "issue") {
    const labels = node["labels"] as { nodes?: unknown[] } | undefined;
    return { ...node, labels: labels?.nodes ?? [] };
  }
  return node;
}

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
        const labels = asArray(r["labels"])
          .map((l) => asString(asRecord(l)["name"]))
          .filter(Boolean);
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
        throw new Error(
          `linear.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`,
        );
    }
  },

  verifyWebhook(payload, headers, secret): boolean {
    if (!secret) return false;
    const sig = headers["linear-signature"];
    if (!sig) return false;
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    return constantTimeStringEqual(sig, expected);
  },

  // Incremental GraphQL poll. Fetches records of `recordType` updated after the
  // cursor (max updatedAt from the previous poll), ordered by updatedAt so a
  // bounded page is deterministic. Linear's Bearer/API-key auth is unified by
  // linearAuthHeader.
  async *poll(auth, _config, recordType, cursor): AsyncIterable<RawRecord> {
    const authHeader = linearAuthHeader(auth);
    if (!authHeader) return;
    const field = QUERY_FIELD[recordType];
    const selection = NODE_SELECTIONS[recordType];
    if (!field || !selection) return; // not a pollable record type

    const filter = cursor ? `filter: { updatedAt: { gt: "${cursor}" } }, ` : "";
    const query = `query { ${field}(${filter}first: 100, orderBy: updatedAt) { nodes { ${selection} } } }`;

    const resp = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) {
      throw new Error(
        `linear.poll: GraphQL API ${resp.status} for ${recordType}`,
      );
    }
    const json = (await resp.json()) as {
      data?: Record<string, { nodes?: Array<Record<string, unknown>> }>;
      errors?: Array<{ message: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `linear.poll: GraphQL error — ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }
    const nodes = json.data?.[field]?.nodes ?? [];
    const now = new Date().toISOString();
    for (const node of nodes) {
      const id = asString(node["id"]) ?? "";
      if (!id) continue;
      yield {
        sourceRecordType: recordType,
        externalId: id,
        raw: reshapeLinearNode(recordType, node),
        receivedAt: now,
      };
    }
  },

  // Cursor watermark: Linear's updatedAt on every record type.
  cursorOf(_recordType, raw): string | null {
    return asString(asRecord(raw)["updatedAt"]) ?? null;
  },
};

registerConnector(linear);

export { linear };
