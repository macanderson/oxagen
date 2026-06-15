import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { registerConnector, type ConnectorDefinition, type NormalizedRecord, type RecordTypeSample, type WebhookExtraction } from "../types";

const connectionConfigSchema = z.object({
  organizations: z.array(z.string()).min(1),
  repositories: z.array(z.string()).optional(),
  syncDepthDays: z.number().int().positive().default(90),
});

// Utility functions to safely extract values
function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
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

const github: ConnectorDefinition<typeof connectionConfigSchema> = {
  connectorId: "github",
  displayName: "GitHub",
  description: "Sync pull requests, issues, commits, releases, and sources from GitHub repositories.",
  icon: "github",
  supportedAuthSchemes: ["oauth2_authorization_code", "api_key"],
  deliveryMethod: "webhook",
  defaultPollIntervalSeconds: 300,
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    return [
      {
        sourceRecordType: "pull_request",
        displayName: "Pull Requests",
        sampleRecords: [],
        fieldSchema: {
          title: "string",
          body: "string",
          state: "string",
          author: "string",
          labels: "string[]",
          url: "string",
          mergedAt: "string",
          createdAt: "string",
          updatedAt: "string",
        },
      },
      {
        sourceRecordType: "issue",
        displayName: "Issues",
        sampleRecords: [],
        fieldSchema: {
          title: "string",
          body: "string",
          state: "string",
          author: "string",
          labels: "string[]",
          url: "string",
          closedAt: "string",
          createdAt: "string",
          updatedAt: "string",
        },
      },
      {
        sourceRecordType: "commit",
        displayName: "Commits",
        sampleRecords: [],
        fieldSchema: {
          sha: "string",
          message: "string",
          author: "string",
          authorEmail: "string",
          committedAt: "string",
          url: "string",
          git_branch: "string",
        },
      },
      {
        sourceRecordType: "repository",
        displayName: "Repositories",
        sampleRecords: [],
        fieldSchema: {
          name: "string",
          fullName: "string",
          description: "string",
          owner: "string",
          private: "boolean",
          language: "string",
          stargazersCount: "number",
          url: "string",
          createdAt: "string",
          updatedAt: "string",
        },
      },
      {
        sourceRecordType: "release",
        displayName: "Releases",
        sampleRecords: [],
        fieldSchema: {
          name: "string",
          tagName: "string",
          body: "string",
          author: "string",
          draft: "boolean",
          prerelease: "boolean",
          publishedAt: "string",
          url: "string",
        },
      },
      {
        sourceRecordType: "code_review",
        displayName: "Code Reviews",
        sampleRecords: [],
        fieldSchema: {
          body: "string",
          url: "string",
          createdAt: "string",
        },
      },
      {
        sourceRecordType: "comment",
        displayName: "Comments",
        sampleRecords: [],
        fieldSchema: {
          body: "string",
          url: "string",
          createdAt: "string",
        },
      },
      {
        sourceRecordType: "source",
        displayName: "Source Files",
        sampleRecords: [],
        fieldSchema: {
          path: "string",
          type: "string",
          size: "number",
          mode: "string",
          sha: "string",
          url: "string",
        },
      },
    ];
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);

    switch (sourceRecordType) {
      // Pull requests
      case "pull_request": {
        const user = asRecord(r["user"]);
        const labels = asArray(r["labels"])
          .map((l) => asString(asRecord(l)["name"]))
          .filter((n): n is string => !!n);
        return {
          externalId: r["number"] !== undefined ? String(r["number"]) : r["id"] !== undefined ? String(r["id"]) : "",
          externalUrl: asString(r["html_url"]) ?? undefined,
          displayName: asString(r["title"]) ?? undefined,
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

      // Issues
      case "issue": {
        const user = asRecord(r["user"]);
        const labels = asArray(r["labels"])
          .map((l) => asString(asRecord(l)["name"]))
          .filter((n): n is string => !!n);
        return {
          externalId: r["number"] !== undefined ? String(r["number"]) : r["id"] !== undefined ? String(r["id"]) : "",
          externalUrl: asString(r["html_url"]) ?? undefined,
          displayName: asString(r["title"]) ?? undefined,
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

      // Commits
      case "commit": {
        const commitObj = asRecord(r["commit"]);
        const authorObj = asRecord(commitObj["author"]);
        // git_branch may be injected into the raw payload by the caller (e.g. a push
        // webhook dispatcher or the polling sync that knows the branch it listed commits
        // from). When present, it is forwarded to the EntityNode as a property so that
        // trigger conditions can match on `git_branch = 'main'`.
        const gitBranch = asString(r["git_branch"]);
        return {
          externalId: asString(r["sha"]) ?? (r["id"] !== undefined ? String(r["id"]) : ""),
          externalUrl: asString(r["html_url"]) ?? undefined,
          displayName: asString(commitObj["message"]) ? asString(commitObj["message"])!.split("\n")[0] : undefined,
          properties: {
            sha: asString(r["sha"]),
            message: asString(commitObj["message"]),
            author: asString(authorObj["name"]),
            authorEmail: asString(authorObj["email"]),
            committedAt: asString(authorObj["date"]),
            url: asString(r["html_url"]),
            ...(gitBranch !== undefined ? { git_branch: gitBranch } : {}),
          },
        };
      }

      // Repositories
      case "repository": {
        const owner = asRecord(r["owner"]);
        return {
          externalId: r["id"] !== undefined ? String(r["id"]) : "",
          externalUrl: asString(r["html_url"]) ?? undefined,
          displayName: asString(r["full_name"]) ?? asString(r["name"]) ?? undefined,
          properties: {
            name: asString(r["name"]),
            fullName: asString(r["full_name"]),
            description: asString(r["description"]),
            owner: asString(owner["login"]),
            private: typeof r["private"] === "boolean" ? r["private"] : undefined,
            language: asString(r["language"]),
            stargazersCount: asNumber(r["stargazers_count"]),
            url: asString(r["html_url"]),
            createdAt: asString(r["created_at"]),
            updatedAt: asString(r["updated_at"]),
          },
        };
      }

      // Releases
      case "release": {
        const author = asRecord(r["author"]);
        return {
          externalId: r["id"] !== undefined ? String(r["id"]) : "",
          externalUrl: asString(r["html_url"]) ?? undefined,
          displayName: asString(r["name"]) ?? asString(r["tag_name"]) ?? undefined,
          properties: {
            name: asString(r["name"]),
            tagName: asString(r["tag_name"]),
            body: asString(r["body"]),
            author: asString(author["login"]),
            draft: typeof r["draft"] === "boolean" ? r["draft"] : undefined,
            prerelease: typeof r["prerelease"] === "boolean" ? r["prerelease"] : undefined,
            publishedAt: asString(r["published_at"]),
            url: asString(r["html_url"]),
          },
        };
      }

      // Code reviews and comments
      case "code_review":
      case "comment":
        return {
          externalId: r["id"] !== undefined ? String(r["id"]) : "",
          externalUrl: asString(r["html_url"]) ?? undefined,
          displayName: asString(r["body"]) ? asString(r["body"])!.slice(0, 100) : undefined,
          properties: {
            body: asString(r["body"]),
            url: asString(r["html_url"]),
            createdAt: asString(r["created_at"]),
          },
        };

      // Sources (with more robust field checks)
      case "source": {
        // For demonstration, support both file and directory
        // Accepts GitHub API tree/blob responses, or webhook payloads for files

        // Try github REST output for a tree entry
        if (
          typeof r["type"] === "string" &&
          (r["type"] === "blob" || r["type"] === "tree")
        ) {
          return {
            externalId: asString(r["sha"]) ?? (r["id"] !== undefined ? String(r["id"]) : ""),
            externalUrl: asString(r["url"]) ?? asString(r["html_url"]) ?? undefined,
            displayName: asString(r["path"]) ?? undefined,
            properties: {
              path: asString(r["path"]),
              type: asString(r["type"]), // 'tree' (directory), 'blob' (file)
              size: asNumber(r["size"]),
              mode: asString(r["mode"]),
              sha: asString(r["sha"]),
              url: asString(r["url"]),
            },
          };
        }
        // Try a file object from webhook (push event)
        if (typeof r["filename"] === "string") {
          return {
            externalId: asString(r["sha"]) ?? (r["id"] !== undefined ? String(r["id"]) : ""),
            externalUrl: asString(r["url"]) ?? asString(r["blob_url"]) ?? asString(r["raw_url"]) ?? undefined,
            displayName: asString(r["filename"]),
            properties: {
              path: asString(r["filename"]),
              status: asString(r["status"]),
              additions: asNumber(r["additions"]),
              deletions: asNumber(r["deletions"]),
              changes: asNumber(r["changes"]),
              sha: asString(r["sha"]),
              blobUrl: asString(r["blob_url"]),
              rawUrl: asString(r["raw_url"]),
            },
          };
        }
        // Could not determine source type
        return {
          externalId: asString(r["sha"]) ?? (asString(r["id"]) ?? ""),
          externalUrl: asString(r["url"]) ?? undefined,
          displayName: asString(r["path"]) ?? asString(r["filename"]) ?? "Unknown",
          properties: r,
        };
      }

      default:
        throw new Error(`github.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`);
    }
  },

  // Translate a GitHub webhook delivery into ingestable records.
  //
  // GitHub's event names (the `x-github-event` header) do not match this
  // connector's sourceRecordType keys, and the ingestable record is nested
  // inside the event envelope. This method bridges both gaps so the downstream
  // pipeline receives a (sourceRecordType, record) pair that normalizeRecord()
  // and the entity_type_mappings lookup both understand.
  parseWebhookEvent(eventName: string, raw: unknown): WebhookExtraction[] {
    const p = asRecord(raw);

    const one = (sourceRecordType: string, key: string): WebhookExtraction[] => {
      const record = asRecord(p[key]);
      return Object.keys(record).length > 0 ? [{ sourceRecordType, record }] : [];
    };

    switch (eventName) {
      case "pull_request":
        return one("pull_request", "pull_request");
      case "issues":
        return one("issue", "issue");
      case "issue_comment":
      case "pull_request_review_comment":
        return one("comment", "comment");
      case "pull_request_review":
        return one("code_review", "review");
      case "release":
        return one("release", "release");
      case "repository":
        return one("repository", "repository");

      // A push carries N commits. Reshape each into the shape normalizeRecord("commit")
      // expects: top-level sha + html_url, nested commit.{message, author.{name,email,date}},
      // plus the branch (derived from refs/heads/<branch>) as git_branch so trigger
      // conditions can match on the branch.
      case "push": {
        const ref = asString(p["ref"]);
        const branch =
          ref && ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
        return asArray(p["commits"]).flatMap((c): WebhookExtraction[] => {
          const commit = asRecord(c);
          const author = asRecord(commit["author"]);
          const sha = asString(commit["id"]);
          if (!sha) return [];
          return [
            {
              sourceRecordType: "commit",
              record: {
                sha,
                html_url: asString(commit["url"]),
                ...(branch !== undefined ? { git_branch: branch } : {}),
                commit: {
                  message: asString(commit["message"]),
                  author: {
                    name: asString(author["name"]),
                    email: asString(author["email"]),
                    date: asString(commit["timestamp"]),
                  },
                },
              },
            },
          ];
        });
      }

      // ping, installation, installation_repositories, create, delete, fork, star,
      // check_run, … — no ingestable data record (lifecycle handled by the route).
      default:
        return [];
    }
  },

  verifyWebhook(payload, headers, secret): boolean {
    if (!secret) return false;
    const sig = headers["x-hub-signature-256"];
    if (!sig || typeof sig !== "string") return false;
    const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    try {
      // Normalize lengths before timingSafeEqual to prevent crash
      const sigBuf = Buffer.from(sig, "utf8");
      const expBuf = Buffer.from(expected, "utf8");
      if (sigBuf.length !== expBuf.length) return false;
      return timingSafeEqual(sigBuf, expBuf);
    } catch {
      return false;
    }
  },
};

registerConnector(github);

export { github };
