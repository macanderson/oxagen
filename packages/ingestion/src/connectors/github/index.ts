import { createHmac } from "node:crypto";
import { z } from "zod";
import { constantTimeStringEqual } from "../safe-compare";
import {
  registerConnector,
  type AuthCredential,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RawRecord,
  type RecordTypeSample,
  type WebhookExtraction,
} from "../types";

// Accepts BOTH the wizard/resync shape actually stored in delivery_config
// ({ owner, repo, defaultBranch }) and the legacy org/repo-list shape. The poll
// loop derives its target repos from whichever is present.
const connectionConfigSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  defaultBranch: z.string().optional(),
  repositories: z.array(z.string()).optional(),
  organizations: z.array(z.string()).optional(),
  syncDepthDays: z.number().int().positive().default(90),
});

type Config = z.infer<typeof connectionConfigSchema>;

/** Resolve a usable GitHub token from the resolved connection credential. */
function githubToken(auth: AuthCredential): string | null {
  if (auth.scheme === "bearer_token") return auth.token;
  if (auth.scheme === "api_key") return auth.apiKey;
  return null;
}

/**
 * Derive the { owner, repo } targets to poll from the stored config.
 *
 * Reads `owner`/`repo` first, then the `repositories` "owner/name" list.
 * `config.organizations` is accepted by the config schema but NOT expanded
 * here — polling an org requires a repo-listing API call this pure helper does
 * not make, so an org-only connection polls nothing.
 */
function pollTargets(config: Config): Array<{ owner: string; repo: string }> {
  if (config.owner && config.repo)
    return [{ owner: config.owner, repo: config.repo }];
  const out: Array<{ owner: string; repo: string }> = [];
  for (const full of config.repositories ?? []) {
    const [owner, repo] = full.split("/");
    if (owner && repo) out.push({ owner, repo });
  }
  return out;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "oxagen-ingestion/1.0",
  };
}

/**
 * Fetch ONE page of a GitHub list endpoint. There is no `Link`-header
 * pagination: a poll that finds more than `per_page` changed records since the
 * cursor sees only the first page, and the cursor still advances past the rest.
 */
async function ghListPage(url: string, token: string): Promise<unknown[]> {
  const resp = await fetch(url, { headers: ghHeaders(token) });
  if (resp.status === 404) return [];
  if (!resp.ok) {
    throw new Error(`github.poll: GitHub API ${resp.status} for ${url}`);
  }
  const data = (await resp.json()) as unknown;
  return Array.isArray(data) ? (data as unknown[]) : [];
}

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
  description:
    "Sync repository, pull request, issue, commit, and release metadata from GitHub.",
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
          externalId:
            r["number"] !== undefined
              ? String(r["number"])
              : r["id"] !== undefined
                ? String(r["id"])
                : "",
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
          externalId:
            r["number"] !== undefined
              ? String(r["number"])
              : r["id"] !== undefined
                ? String(r["id"])
                : "",
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
          externalId:
            asString(r["sha"]) ??
            (r["id"] !== undefined ? String(r["id"]) : ""),
          externalUrl: asString(r["html_url"]) ?? undefined,
          displayName: asString(commitObj["message"])
            ? asString(commitObj["message"])!.split("\n")[0]
            : undefined,
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
          displayName:
            asString(r["full_name"]) ?? asString(r["name"]) ?? undefined,
          properties: {
            name: asString(r["name"]),
            fullName: asString(r["full_name"]),
            description: asString(r["description"]),
            owner: asString(owner["login"]),
            private:
              typeof r["private"] === "boolean" ? r["private"] : undefined,
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
          displayName:
            asString(r["name"]) ?? asString(r["tag_name"]) ?? undefined,
          properties: {
            name: asString(r["name"]),
            tagName: asString(r["tag_name"]),
            body: asString(r["body"]),
            author: asString(author["login"]),
            draft: typeof r["draft"] === "boolean" ? r["draft"] : undefined,
            prerelease:
              typeof r["prerelease"] === "boolean"
                ? r["prerelease"]
                : undefined,
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
          displayName: asString(r["body"])
            ? asString(r["body"])!.slice(0, 100)
            : undefined,
          properties: {
            body: asString(r["body"]),
            url: asString(r["html_url"]),
            createdAt: asString(r["created_at"]),
          },
        };

      default:
        throw new Error(
          `github.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`,
        );
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

    const one = (
      sourceRecordType: string,
      key: string,
    ): WebhookExtraction[] => {
      const record = asRecord(p[key]);
      return Object.keys(record).length > 0
        ? [{ sourceRecordType, record }]
        : [];
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
          ref && ref.startsWith("refs/heads/")
            ? ref.slice("refs/heads/".length)
            : ref;
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
    const expected =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    return constantTimeStringEqual(sig, expected);
  },

  // Incremental poll. GitHub webhooks give realtime deltas, but a poll fills
  // the gaps (missed deliveries, backfill after connect) and makes the source a
  // "real" ongoing sync. For each configured repo, fetch the most-recently-
  // updated records of the requested type and yield those changed since the
  // cursor (the max updated_at from the previous poll). Commits use GitHub's
  // native `since` filter; the rest sort by `updated` desc and stop at cursor.
  async *poll(auth, config, recordType, cursor): AsyncIterable<RawRecord> {
    const token = githubToken(auth);
    if (!token) return;
    const targets = pollTargets(config);
    const now = new Date().toISOString();

    for (const { owner, repo } of targets) {
      const base = `https://api.github.com/repos/${owner}/${repo}`;

      if (recordType === "commit") {
        const sinceQuery = cursor ? `&since=${encodeURIComponent(cursor)}` : "";
        const rows = await ghListPage(
          `${base}/commits?per_page=100${sinceQuery}`,
          token,
        );
        for (const raw of rows) {
          const id = (raw as { sha?: string }).sha ?? "";
          if (!id) continue;
          yield {
            sourceRecordType: "commit",
            externalId: id,
            raw,
            receivedAt: now,
          };
        }
        continue;
      }

      if (recordType === "pull_request" || recordType === "issue") {
        const path = recordType === "pull_request" ? "pulls" : "issues";
        const rows = await ghListPage(
          `${base}/${path}?state=all&sort=updated&direction=desc&per_page=100`,
          token,
        );
        for (const raw of rows) {
          const r = raw as {
            updated_at?: string;
            pull_request?: unknown;
            number?: number;
          };
          // The issues endpoint also returns PRs — drop them here.
          if (recordType === "issue" && r.pull_request !== undefined) continue;
          if (cursor && r.updated_at && r.updated_at <= cursor) break; // sorted desc
          yield {
            sourceRecordType: recordType,
            externalId: r.number !== undefined ? String(r.number) : "",
            raw,
            receivedAt: now,
          };
        }
        continue;
      }

      if (recordType === "release") {
        const rows = await ghListPage(`${base}/releases?per_page=100`, token);
        for (const raw of rows) {
          const r = raw as {
            id?: number;
            published_at?: string;
            created_at?: string;
          };
          const stamp = r.published_at ?? r.created_at;
          if (cursor && stamp && stamp <= cursor) continue;
          yield {
            sourceRecordType: "release",
            externalId: r.id !== undefined ? String(r.id) : "",
            raw,
            receivedAt: now,
          };
        }
        continue;
      }

      if (recordType === "repository") {
        const resp = await fetch(base, { headers: ghHeaders(token) });
        if (!resp.ok) continue;
        const raw = (await resp.json()) as { id?: number; updated_at?: string };
        if (cursor && raw.updated_at && raw.updated_at <= cursor) continue;
        yield {
          sourceRecordType: "repository",
          externalId: raw.id !== undefined ? String(raw.id) : "",
          raw,
          receivedAt: now,
        };
        continue;
      }
      // code_review / comment are webhook-only — no poll.
    }
  },

  // Cursor watermark: the source's last-modified timestamp for the record type.
  cursorOf(recordType, raw): string | null {
    const r = asRecord(raw);
    switch (recordType) {
      case "commit": {
        const commit = asRecord(r["commit"]);
        const author = asRecord(commit["author"]);
        const committer = asRecord(commit["committer"]);
        return asString(committer["date"]) ?? asString(author["date"]) ?? null;
      }
      case "release":
        return asString(r["published_at"]) ?? asString(r["created_at"]) ?? null;
      default:
        return asString(r["updated_at"]) ?? null;
    }
  },
};

registerConnector(github);

export { github };
