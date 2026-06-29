import { NonRetriableError } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { createIngestionCryptoAdapter, decrypt } from "@oxagen/crypto";
import { runInTenantScope } from "@oxagen/tenancy";
import { upsertSourceConnectionMeta } from "@oxagen/ingestion/mutations";
import { logger } from "../logger";

// Paths to exclude from the file tree (not worth parsing).
const EXCLUDED_PREFIXES = ["node_modules/", "dist/", ".git/", "__pycache__/"];
// Extensions we process. Code (tree-sitter parsed into symbols) + markdown
// documentation (parsed into heading sections). Every matched file has its full
// content embedded for natural-language search regardless of symbol extraction.
const ALLOWED_EXTENSIONS = [".ts", ".tsx", ".py", ".md", ".mdx", ".markdown"];
// Maximum files dispatched per sync to keep fan-out bounded.
const MAX_FILES = 500;
// Maximum events sent per step.sendEvent batch call.
const BATCH_SIZE = 50;
// Cap on historical domain records (PRs/issues/releases/commits) pulled per type
// on the initial backfill, to bound GitHub API + downstream pipeline fan-out.
const MAX_RECORDS_PER_TYPE = 100;

interface GitTreeItem {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
  url: string;
}

interface GitTreeResponse {
  sha: string;
  url: string;
  tree: GitTreeItem[];
  truncated: boolean;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "oxagen-ingestion/1.0",
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Fetch a GitHub list endpoint, returning the JSON array (or [] on a non-array
 * body). A non-2xx response throws so Inngest retries the step. 404 (repo gone /
 * no access) is treated as empty so one bad repo doesn't fail the whole sync.
 */
async function ghList(url: string, token: string): Promise<unknown[]> {
  const resp = await fetch(url, { headers: ghHeaders(token) });
  if (resp.status === 404) return [];
  if (!resp.ok) {
    throw new Error(`ingestion-github-initial-sync: GitHub list API ${resp.status} for ${url}`);
  }
  const data = (await resp.json()) as unknown;
  return Array.isArray(data) ? (data as unknown[]) : [];
}

/**
 * GitHub initial-sync Inngest function.
 *
 * Triggered by "ingestion/github.initial-sync". For a single repo it:
 *   1. resolves an access token and the repo's real default branch,
 *   2. backfills domain entities — the repository itself plus recent pull
 *      requests, issues, releases, and commits — by emitting one
 *      "ingestion/entity.received" per record (the ingestion pipeline normalizes,
 *      maps, and upserts each into the Neo4j knowledge graph),
 *   3. fans out one "ingestion/github.parse-file" per parseable source file,
 *   4. upserts the SourceConnection meta-node and marks the connection connected.
 *
 * Previously this only walked the file tree, so connecting a repo populated the
 * graph with source-file symbols but NO repository/PR/issue/release entities —
 * the graph looked empty. Concurrency is limited to 2 syncs per org.
 */
export const [ingestionGithubInitialSync] = createFunction(
  {
    id: "ingestion-github-initial-sync",
    retries: 3,
    concurrency: { limit: 2, key: "event.data.orgId" },
  },
  { event: "ingestion/github.initial-sync" },
  async ({ event, step }) => {
    const { connectionId, orgId, workspaceId, owner, repo } = event.data as {
      connectionId: string;
      orgId: string;
      workspaceId: string;
      owner: string;
      repo: string;
      // defaultBranch (legacy) is ignored — we resolve the real one below.
      // syncDepthDays is accepted but the initial backfill is currently bounded by
      // MAX_RECORDS_PER_TYPE rather than a date window.
      syncDepthDays?: number;
    };

    // Guard: if owner or repo is empty the GitHub API call is doomed (404).
    // Throw NonRetriableError immediately so we don't burn retries and surface
    // a clear message instead of a cryptic 404.
    if (!owner || !repo) {
      throw new NonRetriableError(
        `ingestion-github-initial-sync: owner and repo are required but received owner="${owner}" repo="${repo}" for connectionId=${connectionId}. ` +
          "Ensure the GitHub connection wizard sends owner/repo in the connection.mappings.set payload.",
      );
    }

    const repoBase = `https://api.github.com/repos/${owner}/${repo}`;

    // ── Step 1: Fetch access token from Postgres ─────────────────────────────
    const accessToken = await step.run("fetch-access-token", async () => {
      const rows = await withSystemDb(async (tx) => {
        const result = await tx.execute(sql`
          SELECT oa.access_token_enc
          FROM   ingestion.oauth_accounts oa
          JOIN   ingestion.source_connections sc
                 ON sc.oauth_account_id = oa.id
          WHERE  sc.id     = ${connectionId}::uuid
          AND    sc.org_id = ${orgId}::uuid
          LIMIT  1
        `);
        return Array.from(result) as Array<{
          access_token_enc: { keyId: string; ciphertext: string } | null;
        }>;
      });

      const row = rows[0];
      if (!row?.access_token_enc) {
        throw new Error(`ingestion-github-initial-sync: no oauth token for connectionId=${connectionId}`);
      }

      const cryptoAdapter = createIngestionCryptoAdapter();
      const cipherBuf = Buffer.from(row.access_token_enc.ciphertext, "base64");
      const decrypted: unknown = await decrypt(cipherBuf, cryptoAdapter.keyId, {
        adapter: cryptoAdapter.adapter,
      });
      return Buffer.isBuffer(decrypted) ? decrypted.toString("utf8") : String(decrypted);
    });

    // ── Step 2: Fetch repository metadata (also gives the real default branch) ─
    const repoMeta = await step.run("fetch-repo", async () => {
      const resp = await fetch(repoBase, { headers: ghHeaders(accessToken) });
      if (!resp.ok) {
        throw new Error(
          `ingestion-github-initial-sync: GitHub repo API returned ${resp.status} for ${owner}/${repo}`,
        );
      }
      return (await resp.json()) as Record<string, unknown>;
    });

    const defaultBranch =
      typeof repoMeta["default_branch"] === "string" ? (repoMeta["default_branch"] as string) : "main";

    // Helper: build an entity.received event for one raw GitHub record.
    const entityEvent = (sourceRecordType: string, payload: unknown) =>
      ({
        name: "ingestion/entity.received" as const,
        data: { connectionId, workspaceId, orgId, connectorType: "github", sourceRecordType, payload },
      });

    // Helper: dispatch one entity.received per record, batched for Inngest limits.
    // Each batch is a distinct memoized step so retries don't re-fire the whole set.
    const dispatchEntities = async (
      label: string,
      sourceRecordType: string,
      records: unknown[],
    ): Promise<void> => {
      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        await step.sendEvent(
          `emit-${label}-${i}`,
          batch.map((rec) => entityEvent(sourceRecordType, rec)),
        );
      }
    };

    // ── Step 3: Emit the repository entity ───────────────────────────────────
    await step.sendEvent("emit-repository", [entityEvent("repository", repoMeta)]);

    // ── Step 4: Backfill recent pull requests ────────────────────────────────
    const pulls = await step.run("fetch-pulls", () =>
      ghList(
        `${repoBase}/pulls?state=all&per_page=${MAX_RECORDS_PER_TYPE}&sort=updated&direction=desc`,
        accessToken,
      ),
    );
    await dispatchEntities("pulls", "pull_request", pulls);

    // ── Step 5: Backfill recent issues (GitHub's issues API also returns PRs;
    //            drop those — they're handled as pull_request above) ───────────
    const issuesRaw = await step.run("fetch-issues", () =>
      ghList(
        `${repoBase}/issues?state=all&per_page=${MAX_RECORDS_PER_TYPE}&sort=updated&direction=desc`,
        accessToken,
      ),
    );
    const issues = issuesRaw.filter((i) => asRecord(i)["pull_request"] === undefined);
    await dispatchEntities("issues", "issue", issues);

    // ── Step 6: Backfill recent releases ─────────────────────────────────────
    const releases = await step.run("fetch-releases", () =>
      ghList(`${repoBase}/releases?per_page=${MAX_RECORDS_PER_TYPE}`, accessToken),
    );
    await dispatchEntities("releases", "release", releases);

    // ── Step 7: Backfill recent commits on the default branch (inject the
    //            branch so trigger conditions can match on git_branch) ─────────
    const commits = await step.run("fetch-commits", () =>
      ghList(
        `${repoBase}/commits?sha=${encodeURIComponent(defaultBranch)}&per_page=${MAX_RECORDS_PER_TYPE}`,
        accessToken,
      ),
    );
    const commitsWithBranch = commits.map((c) => ({ ...asRecord(c), git_branch: defaultBranch }));
    await dispatchEntities("commits", "commit", commitsWithBranch);

    // ── Step 8: Fetch the repo file tree from GitHub (real default branch) ────
    const filteredFiles = await step.run("fetch-repo-tree", async () => {
      const url = `${repoBase}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`;

      const response = await fetch(url, { headers: ghHeaders(accessToken) });

      if (!response.ok) {
        throw new Error(
          `ingestion-github-initial-sync: GitHub tree API returned ${response.status} for ${owner}/${repo}`,
        );
      }

      const data = (await response.json()) as GitTreeResponse;

      const files = data.tree.filter((item) => {
        if (item.type !== "blob") return false;
        if (!item.size || item.size === 0) return false;

        // Exclude noisy directories.
        const isExcluded = EXCLUDED_PREFIXES.some((prefix) => item.path.startsWith(prefix));
        if (isExcluded) return false;

        // Only allowed extensions.
        const ext = item.path.slice(item.path.lastIndexOf(".")).toLowerCase();
        return ALLOWED_EXTENSIONS.includes(ext);
      });

      // Cap at MAX_FILES to bound fan-out.
      return files.slice(0, MAX_FILES).map((f) => ({
        sha: f.sha,
        path: f.path,
      }));
    });

    logger.info(
      {
        connectionId,
        orgId,
        owner,
        repo,
        fileCount: filteredFiles.length,
        prCount: pulls.length,
        issueCount: issues.length,
        releaseCount: releases.length,
        commitCount: commitsWithBranch.length,
      },
      "ingestion-github-initial-sync: fetched repo + domain records",
    );

    // ── Step 9: Upsert the SourceConnection meta-node in Neo4j ───────────────
    await step.run("upsert-connection-meta", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        upsertSourceConnectionMeta(
          {
            connectionId,
            workspaceId,
            connectorType: "github",
            cursor: null,
            lastSyncAt: new Date().toISOString(),
            entityCountDelta:
              filteredFiles.length +
              1 + // repository
              pulls.length +
              issues.length +
              releases.length +
              commitsWithBranch.length,
            healthStatus: "healthy",
          },
          orgId,
        ),
      ),
    );

    // ── Step 10: Dispatch parse-file events in batches of BATCH_SIZE ──────────
    // `step.sendEvent` MUST be called at the top level — Inngest only memoizes
    // top-level `step.*` calls. Nesting `step.sendEvent` inside a `step.run`
    // closure means the sends are not durably checkpointed: any retry of the
    // outer step re-fires every event, fanning out duplicate parse-file jobs
    // (N×cost explosion on large repos). Each batch is its own memoized step
    // with a stable, index-derived id so replays are deterministic.
    const batches: Array<typeof filteredFiles> = [];
    for (let i = 0; i < filteredFiles.length; i += BATCH_SIZE) {
      batches.push(filteredFiles.slice(i, i + BATCH_SIZE));
    }

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx]!;
      await step.sendEvent(
        `dispatch-files-batch-${batchIdx}`,
        batch.map((file) => ({
          name: "ingestion/github.parse-file" as const,
          data: {
            connectionId,
            orgId,
            workspaceId,
            owner,
            repo,
            sha: file.sha,
            path: file.path,
          },
        })),
      );
    }

    // ── Step 11: Mark connection as connected ─────────────────────────────────
    // "connected" is the live state allowed by source_connections_status_check
    // (pending_setup | connected | paused | error); "active" would fail the CHECK.
    await step.run("update-status", () =>
      withSystemDb((tx) =>
        tx.execute(sql`
          UPDATE ingestion.source_connections
          SET    status       = 'connected',
                 last_sync_at = NOW(),
                 updated_at   = NOW()
          WHERE  id     = ${connectionId}::uuid
          AND    org_id = ${orgId}::uuid
        `),
      ),
    );

    // ── Step 12: Trigger LLM domain inference over the full file tree ───────────
    // Emitted once per initial sync. The infer-domains function classifies every
    // file into an application domain (e.g. "payments", "auth") and stamps
    // `domain` on SourceFile + SourceSymbol nodes in Neo4j, enabling domain-
    // sliced knowledge-graph queries:
    //   MATCH (n:SourceFile {orgId: $orgId, domain: 'payments'})
    if (filteredFiles.length > 0) {
      await step.sendEvent("infer-domains", {
        name: "ingestion/github.infer-domains" as const,
        data: {
          filePaths: filteredFiles.map((f) => f.path),
          orgId,
          workspaceId,
          connectionId,
          owner,
          repo,
        },
      });
    }

    logger.info(
      { connectionId, orgId, owner, repo, fileCount: filteredFiles.length },
      "ingestion-github-initial-sync: completed",
    );

    return {
      connectionId,
      owner,
      repo,
      fileCount: filteredFiles.length,
      entityCount: 1 + pulls.length + issues.length + releases.length + commitsWithBranch.length,
    };
  },
);
