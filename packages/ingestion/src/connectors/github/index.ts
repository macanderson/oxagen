import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { registerConnector, type ConnectorDefinition, type NormalizedRecord, type RecordTypeSample } from "../types";

const connectionConfigSchema = z.object({
  organizations: z.array(z.string()).min(1),
  repositories: z.array(z.string()).optional(),
  syncDepthDays: z.number().int().positive().default(90),
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

const github: ConnectorDefinition<Config> = {
  connectorId: "github",
  displayName: "GitHub",
  description: "Sync pull requests, issues, commits, and releases from GitHub repositories.",
  icon: "github",
  supportedAuthSchemes: ["oauth2_authorization_code", "api_key"],
  deliveryMethod: "webhook",
  defaultPollIntervalSeconds: 300,
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("github.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);

    switch (sourceRecordType) {
      case "pull_request": {
        const user = asRecord(r["user"]);
        const labels = asArray(r["labels"]).map((l) => asString(asRecord(l)["name"])).filter(Boolean);
        return {
          externalId: String(r["number"] ?? r["id"] ?? ""),
          externalUrl: asString(r["html_url"]),
          displayName: asString(r["title"]),
          properties: {
            title: asString(r["title"]),
            body: asString(r["body"]),
            state: asString(r["state"]),
            author: asString(user["login"]),
            labels,
            url: asString(r["html_url"]),
            mergedAt: asString(r["merged_at"]),
            createdAt: asString(r["created_at"]),
            updatedAt: asString(r["updated_at"]),
          },
        };
      }

      case "issue": {
        const user = asRecord(r["user"]);
        const labels = asArray(r["labels"]).map((l) => asString(asRecord(l)["name"])).filter(Boolean);
        return {
          externalId: String(r["number"] ?? r["id"] ?? ""),
          externalUrl: asString(r["html_url"]),
          displayName: asString(r["title"]),
          properties: {
            title: asString(r["title"]),
            body: asString(r["body"]),
            state: asString(r["state"]),
            author: asString(user["login"]),
            labels,
            url: asString(r["html_url"]),
            closedAt: asString(r["closed_at"]),
            createdAt: asString(r["created_at"]),
            updatedAt: asString(r["updated_at"]),
          },
        };
      }

      case "commit": {
        const commitObj = asRecord(r["commit"]);
        const authorObj = asRecord(commitObj["author"]);
        return {
          externalId: asString(r["sha"]) ?? String(r["id"] ?? ""),
          externalUrl: asString(r["html_url"]),
          displayName: asString(commitObj["message"])?.split("\n")[0],
          properties: {
            sha: asString(r["sha"]),
            message: asString(commitObj["message"]),
            author: asString(authorObj["name"]),
            authorEmail: asString(authorObj["email"]),
            committedAt: asString(authorObj["date"]),
            url: asString(r["html_url"]),
          },
        };
      }

      case "repository": {
        const owner = asRecord(r["owner"]);
        return {
          externalId: String(r["id"] ?? ""),
          externalUrl: asString(r["html_url"]),
          displayName: asString(r["full_name"]) ?? asString(r["name"]),
          properties: {
            name: asString(r["name"]),
            fullName: asString(r["full_name"]),
            description: asString(r["description"]),
            owner: asString(owner["login"]),
            private: r["private"],
            language: asString(r["language"]),
            stargazersCount: asNumber(r["stargazers_count"]),
            url: asString(r["html_url"]),
            createdAt: asString(r["created_at"]),
            updatedAt: asString(r["updated_at"]),
          },
        };
      }

      case "release": {
        const author = asRecord(r["author"]);
        return {
          externalId: String(r["id"] ?? ""),
          externalUrl: asString(r["html_url"]),
          displayName: asString(r["name"]) ?? asString(r["tag_name"]),
          properties: {
            name: asString(r["name"]),
            tagName: asString(r["tag_name"]),
            body: asString(r["body"]),
            author: asString(author["login"]),
            draft: r["draft"],
            prerelease: r["prerelease"],
            publishedAt: asString(r["published_at"]),
            url: asString(r["html_url"]),
          },
        };
      }

      case "code_review":
      case "comment":
        return {
          externalId: String(r["id"] ?? ""),
          externalUrl: asString(r["html_url"]),
          displayName: asString(r["body"])?.slice(0, 100),
          properties: {
            body: asString(r["body"]),
            url: asString(r["html_url"]),
            createdAt: asString(r["created_at"]),
          },
        };

      default:
        throw new Error(`github.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`);
    }
  },

  verifyWebhook(payload, headers, secret): boolean {
    if (!secret) return false;
    const sig = headers["x-hub-signature-256"];
    if (!sig) return false;
    const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  },
};

registerConnector(github);

export { github };
