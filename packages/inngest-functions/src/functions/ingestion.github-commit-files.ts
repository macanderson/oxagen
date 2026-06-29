import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { createIngestionCryptoAdapter, decrypt } from "@oxagen/crypto";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { logger } from "../logger";

// Defensive cap: skip files beyond this count for a single commit (large
// merge commits can touch hundreds of files; we stop early and log).
const MAX_FILES_PER_COMMIT = 200;

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "oxagen-ingestion/1.0",
  };
}

interface GithubCommitFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes?: number;
}

interface GithubCommitDetail {
  sha: string;
  commit: {
    message: string;
    author: {
      name: string;
      date: string;
    };
  };
  // GitHub omits `files` when the commit touches > 300 files (truncated merge
  // commits). We treat absence as an empty list and log it.
  files?: GithubCommitFile[];
}

/**
 * GitHub commit-files Inngest function.
 *
 * Triggered by "ingestion/github.commit-files" — one event per commit, fanned
 * out from ingestion-github-initial-sync (capped at MAX_COMMIT_FILE_SYNC most
 * recent commits to respect GitHub API quotas).
 *
 * For a single commit SHA it:
 *   1. Resolves the access token from Postgres.
 *   2. Fetches GET /repos/{owner}/{repo}/commits/{sha} to get the file-change
 *      list (additions / deletions / status per file).
 *   3. MERGEs a :Commit {:GraphNode} node in Neo4j (tenant-scoped).
 *   4. For each changed file that already has a :SourceFile node in the graph,
 *      MERGEs a (:Commit)-[:MODIFIED]->(:SourceFile) edge.  Files without a
 *      matching :SourceFile (e.g. binaries, lockfiles, un-indexed paths) are
 *      silently skipped and counted in the return value.
 *
 * This makes "recent changes related to X" answerable from the workspace
 * knowledge graph: walk (:SourceFile)<-[:MODIFIED]-(:Commit) and rank by
 * Commit.committedAt.
 */
export const [ingestionGithubCommitFiles] = createFunction(
  {
    id: "ingestion-github-commit-files",
    retries: 3,
    concurrency: { limit: 5, key: "event.data.orgId" },
  },
  { event: "ingestion/github.commit-files" },
  async ({ event, step }) => {
    const { connectionId, orgId, workspaceId, owner, repo, sha } =
      event.data as {
        connectionId: string;
        orgId: string;
        workspaceId: string;
        owner: string;
        repo: string;
        sha: string;
      };

    const repoBase = `https://api.github.com/repos/${owner}/${repo}`;

    // ── Step 1: Fetch access token from Postgres ───────────────────────────────
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
        throw new Error(
          `ingestion-github-commit-files: no oauth token for connectionId=${connectionId}`,
        );
      }

      const cryptoAdapter = createIngestionCryptoAdapter();
      const cipherBuf = Buffer.from(
        row.access_token_enc.ciphertext,
        "base64",
      );
      const decrypted: unknown = await decrypt(
        cipherBuf,
        cryptoAdapter.keyId,
        { adapter: cryptoAdapter.adapter },
      );
      return Buffer.isBuffer(decrypted)
        ? decrypted.toString("utf8")
        : String(decrypted);
    });

    // ── Step 2: Fetch commit detail (file list) from GitHub ────────────────────
    const commitDetail = await step.run("fetch-commit-detail", async () => {
      const url = `${repoBase}/commits/${encodeURIComponent(sha)}`;
      const resp = await fetch(url, { headers: ghHeaders(accessToken) });

      if (resp.status === 404) {
        // Commit no longer accessible (force-push or repo deletion) — not
        // retryable; the data is simply gone.
        logger.warn(
          { connectionId, orgId, owner, repo, sha },
          "ingestion-github-commit-files: commit 404, skipping",
        );
        return null;
      }

      if (!resp.ok) {
        throw new Error(
          `ingestion-github-commit-files: GitHub commit API ${resp.status} for ${owner}/${repo}@${sha}`,
        );
      }

      return (await resp.json()) as GithubCommitDetail;
    });

    if (!commitDetail) {
      return { sha, skipped: true, reason: "commit_not_found", edgesWritten: 0 };
    }

    const files = commitDetail.files ?? [];

    // GitHub omits the files array for extremely large merge commits (> 300
    // changed files). Log so coverage is honest rather than silently returning 0.
    if (!commitDetail.files) {
      logger.warn(
        { connectionId, orgId, owner, repo, sha },
        "ingestion-github-commit-files: commit files list absent (> 300 file merge commit?), skipping file edges",
      );
    }

    // Cap the file list to keep Neo4j session time bounded.
    const cappedFiles = files.slice(0, MAX_FILES_PER_COMMIT);
    if (cappedFiles.length < files.length) {
      logger.warn(
        {
          connectionId,
          orgId,
          owner,
          repo,
          sha,
          total: files.length,
          cap: MAX_FILES_PER_COMMIT,
        },
        "ingestion-github-commit-files: file list capped — tail not linked",
      );
    }

    const message = commitDetail.commit?.message ?? "";
    const authorName = commitDetail.commit?.author?.name ?? "";
    const committedAt = commitDetail.commit?.author?.date ?? "";

    // naturalKey format: github:{connectionId}:{owner}/{repo}:{sha}
    const commitNaturalKey = `github:${connectionId}:${owner}/${repo}:${sha}`;

    // Short display name: 7-char SHA + first line of commit message (max 72 chars)
    const displayName =
      `${sha.slice(0, 7)} ${(message.split("\n")[0] ?? "").slice(0, 72)}`.trim();

    // ── Step 3: MERGE :Commit node + :MODIFIED edges in Neo4j ─────────────────
    const result = await step.run("upsert-commit-edges", () =>
      runInTenantScope({ orgId, workspaceId }, async () => {
        const session = scopedSession();
        try {
          // MERGE the :Commit node with :GraphNode anchor so it appears in the
          // graph explorer (graph.search matches :GraphNode scoped by orgId +
          // workspaceId). Properties follow the same pattern as :SourceFile:
          // label / displayName / properties / is_system / sourceId /
          // workspaceId / connectionId.
          await session.run(
            `MERGE (c:Commit {naturalKey: $naturalKey, orgId: $orgId})
             ON CREATE SET
               c.publicId    = randomUUID(),
               c.createdAt   = datetime()
             ON MATCH SET
               c.syncedAt    = datetime()
             SET
               c:GraphNode,
               c.is_system   = true,
               c.sha         = $sha,
               c.message     = $message,
               c.authorName  = $authorName,
               c.committedAt = $committedAt,
               c.repo        = $repo,
               c.owner       = $owner,
               c.connectionId = $connectionId,
               c.sourceId    = $connectionId,
               c.workspaceId = $workspaceId,
               c.label       = 'Commit',
               c.displayName = $displayName,
               c.properties  = $properties,
               c.updatedAt   = datetime()`,
            {
              naturalKey: commitNaturalKey,
              orgId,
              sha,
              message,
              authorName,
              committedAt,
              repo,
              owner,
              connectionId,
              workspaceId,
              displayName,
              properties: JSON.stringify({
                sha,
                message,
                authorName,
                committedAt,
                repo,
                owner,
              }),
            },
          );

          // MERGE :MODIFIED edges for every file whose :SourceFile node exists.
          // Files that haven't been indexed (binaries, lock files, paths outside
          // the ALLOWED_EXTENSIONS filter in the initial-sync) produce no MATCH
          // and are logged as skipped — NOT an error.
          let edgesWritten = 0;
          let filesSkipped = 0;

          for (const file of cappedFiles) {
            // SourceFile naturalKey mirrors ingestion.github-parse-file.ts:
            //   github:{connectionId}:{owner}/{repo}:{path}
            const fileNaturalKey = `github:${connectionId}:${owner}/${repo}:${file.filename}`;

            const edgeResult = await session.run(
              `MATCH (c:Commit {naturalKey: $commitNaturalKey, orgId: $orgId})
               MATCH (f:SourceFile {naturalKey: $fileNaturalKey, orgId: $orgId})
               MERGE (c)-[r:MODIFIED]->(f)
               SET r.status    = $status,
                   r.additions = $additions,
                   r.deletions = $deletions,
                   r.is_system = true,
                   r.updatedAt = datetime()
               RETURN r`,
              {
                commitNaturalKey,
                fileNaturalKey,
                orgId,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
              },
            );

            if (edgeResult.records.length > 0) {
              edgesWritten++;
            } else {
              filesSkipped++;
            }
          }

          logger.info(
            {
              connectionId,
              orgId,
              owner,
              repo,
              sha,
              edgesWritten,
              filesSkipped,
              fileCount: cappedFiles.length,
            },
            "ingestion-github-commit-files: edges written",
          );

          return {
            edgesWritten,
            filesSkipped,
            fileCount: cappedFiles.length,
          };
        } finally {
          await session.close();
        }
      }),
    );

    return {
      sha,
      commitNaturalKey,
      skipped: false,
      edgesWritten: result.edgesWritten,
      filesSkipped: result.filesSkipped,
      fileCount: result.fileCount,
    };
  },
);
