/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- event.data types are declared in inngest.ts Events; untyped here because InstanceType<typeof Inngest> strips EventSchemas generics from the Proxy */
import { inngest } from "../inngest";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { createIngestionCryptoAdapter, decrypt } from "@oxagen/crypto";
import { runInTenantScope } from "@oxagen/tenancy";
import { upsertSourceConnectionMeta } from "@oxagen/ingestion/mutations";
import { logger } from "../logger";

// Paths to exclude from the file tree (not worth parsing).
const EXCLUDED_PREFIXES = ["node_modules/", "dist/", ".git/", "__pycache__/"];
// Extensions we process.
const ALLOWED_EXTENSIONS = [".ts", ".tsx", ".py"];
// Maximum files dispatched per sync to keep fan-out bounded.
const MAX_FILES = 500;
// Maximum events sent per step.sendEvent batch call.
const BATCH_SIZE = 50;

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

/**
 * GitHub initial-sync Inngest function.
 *
 * Triggered by "ingestion/github.initial-sync". Fetches the full repo tree,
 * filters to parseable source files, upserts the SourceConnection meta-node
 * in Neo4j, and fans out one "ingestion/github.parse-file" event per file
 * (batched in groups of 50 to respect Inngest send limits).
 *
 * Concurrency is limited to 2 concurrent syncs per org to avoid hammering
 * the GitHub API with multiple orgs' syncs at once.
 */
export const ingestionGithubInitialSync = inngest.createFunction(
  {
    id: "ingestion-github-initial-sync",
    retries: 3,
    concurrency: { limit: 2, key: "event.data.orgId" },
  },
  { event: "ingestion/github.initial-sync" },
  async ({ event, step }) => {
    const { connectionId, orgId, workspaceId, owner, repo, defaultBranch } = event.data;

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

    // ── Step 2: Fetch the repo file tree from GitHub ──────────────────────────
    const filteredFiles = await step.run("fetch-repo-tree", async () => {
      const url =
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`;

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "oxagen-ingestion/1.0",
        },
      });

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
      { connectionId, orgId, owner, repo, fileCount: filteredFiles.length },
      "ingestion-github-initial-sync: tree fetched",
    );

    // ── Step 3: Upsert the SourceConnection meta-node in Neo4j ───────────────
    await step.run("upsert-connection-meta", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        upsertSourceConnectionMeta(
          {
            connectionId,
            workspaceId,
            connectorType: "github",
            cursor: null,
            lastSyncAt: new Date().toISOString(),
            entityCountDelta: filteredFiles.length,
            healthStatus: "healthy",
          },
          orgId,
        ),
      ),
    );

    // ── Step 4: Dispatch parse-file events in batches of BATCH_SIZE ───────────
    await step.run("dispatch-file-parse", async () => {
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
    });

    // ── Step 5: Mark connection as active ─────────────────────────────────────
    await step.run("update-status", () =>
      withSystemDb((tx) =>
        tx.execute(sql`
          UPDATE ingestion.source_connections
          SET    status       = 'active',
                 last_sync_at = NOW(),
                 updated_at   = NOW()
          WHERE  id     = ${connectionId}::uuid
          AND    org_id = ${orgId}::uuid
        `),
      ),
    );

    logger.info(
      { connectionId, orgId, owner, repo, fileCount: filteredFiles.length },
      "ingestion-github-initial-sync: completed",
    );

    return { connectionId, owner, repo, fileCount: filteredFiles.length };
  },
);
