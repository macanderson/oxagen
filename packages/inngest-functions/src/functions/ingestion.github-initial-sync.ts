import { NonRetriableError } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { resolveIngestionCryptoAdapterForKeyId, decrypt } from "@oxagen/crypto";
import { runInTenantScope } from "@oxagen/tenancy";
import { upsertSourceConnectionMeta } from "@oxagen/ingestion/mutations";
import { logger } from "../logger";

// Maximum events sent per step.sendEvent batch call.
const BATCH_SIZE = 50;
// Cap on historical domain records (PRs/issues/releases) pulled per type on the
// initial backfill, to bound GitHub API + downstream pipeline fan-out. Commits
// have their own date-bounded, paginated path below (see MAX_COMMITS_BACKFILL).
const MAX_RECORDS_PER_TYPE = 100;
// Default commit-history window (days) when the event omits syncDepthDays.
// Matches the connection.mappings.set handler default and the GitHub connector
// schema default (packages/ingestion/src/connectors/github/index.ts).
const DEFAULT_SYNC_DEPTH_DAYS = 90;
// GitHub's maximum per_page for the list-commits endpoint.
const COMMITS_PER_PAGE = 100;
// Hard safety cap on total commits fetched for the date-bounded backfill so a
// huge or high-velocity repo can't run away. Worst case is
// MAX_COMMITS_BACKFILL / COMMITS_PER_PAGE = 5 list pages per repo.
const MAX_COMMITS_BACKFILL = 500;
function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "oxagen-ingestion/1.0",
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
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
    throw new Error(
      `ingestion-github-initial-sync: GitHub list API ${resp.status} for ${url}`,
    );
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
 *      requests, issues, and releases (first page each) and commit history
 *      date-bounded by syncDepthDays (paginated, hard-capped at
 *      MAX_COMMITS_BACKFILL) — by emitting one "ingestion/entity.received" per
 *      record (the ingestion pipeline normalizes, maps, and upserts each into
 *      the Neo4j knowledge graph),
 *   3. upserts the SourceConnection meta-node and marks the connection connected.
 *
 * Source content and checkout-specific code graphs intentionally remain local.
 * This server-side sync only ingests provider metadata. Concurrency is limited
 * to 2 syncs per org.
 */
export const [ingestionGithubInitialSync] = createFunction(
  {
    id: "ingestion-github-initial-sync",
    retries: 3,
    concurrency: { limit: 2, key: "event.data.orgId" },
  },
  { event: "ingestion/github.initial-sync" },
  async ({ event, step }) => {
    const {
      connectionId,
      orgId,
      workspaceId,
      owner,
      repo,
      syncDepthDays: syncDepthDaysRaw,
    } = event.data as {
      connectionId: string;
      orgId: string;
      workspaceId: string;
      owner: string;
      repo: string;
      // defaultBranch (legacy) is ignored — we resolve the real one below.
      // syncDepthDays bounds the commit-history backfill window (the wizard's
      // "sync history depth" selector); PRs/issues/releases stay bounded by
      // MAX_RECORDS_PER_TYPE.
      syncDepthDays?: number;
    };

    // Honor the wizard's sync-depth selector for commit history; fall back to
    // the shared 90-day default for legacy events or malformed values.
    const syncDepthDays =
      typeof syncDepthDaysRaw === "number" &&
      Number.isFinite(syncDepthDaysRaw) &&
      syncDepthDaysRaw > 0
        ? syncDepthDaysRaw
        : DEFAULT_SYNC_DEPTH_DAYS;

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
        throw new Error(
          `ingestion-github-initial-sync: no oauth token for connectionId=${connectionId}`,
        );
      }

      // Route by the envelope's stored keyId, not the current provider env var,
      // so tokens wrapped under a previous INGESTION_CRYPTO_PROVIDER still decrypt.
      const cryptoAdapter = resolveIngestionCryptoAdapterForKeyId(
        row.access_token_enc.keyId,
      );
      const cipherBuf = Buffer.from(row.access_token_enc.ciphertext, "base64");
      const decrypted: unknown = await decrypt(cipherBuf, cryptoAdapter.keyId, {
        adapter: cryptoAdapter.adapter,
      });
      return Buffer.isBuffer(decrypted)
        ? decrypted.toString("utf8")
        : String(decrypted);
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
      typeof repoMeta["default_branch"] === "string"
        ? (repoMeta["default_branch"] as string)
        : "main";

    // Helper: build an entity.received event for one raw GitHub record.
    const entityEvent = (sourceRecordType: string, payload: unknown) => ({
      name: "ingestion/entity.received" as const,
      data: {
        connectionId,
        workspaceId,
        orgId,
        connectorType: "github",
        sourceRecordType,
        payload,
      },
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
    await step.sendEvent("emit-repository", [
      entityEvent("repository", repoMeta),
    ]);

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
    const issues = issuesRaw.filter(
      (i) => asRecord(i)["pull_request"] === undefined,
    );
    await dispatchEntities("issues", "issue", issues);

    // ── Step 6: Backfill recent releases ─────────────────────────────────────
    const releases = await step.run("fetch-releases", () =>
      ghList(
        `${repoBase}/releases?per_page=${MAX_RECORDS_PER_TYPE}`,
        accessToken,
      ),
    );
    await dispatchEntities("releases", "release", releases);

    // ── Step 7: Backfill commit history on the default branch, date-bounded by
    //            syncDepthDays (the wizard's "sync history depth" selector) and
    //            paginated up to a hard MAX_COMMITS_BACKFILL safety cap. The
    //            whole loop lives in one step.run so the `since` window and the
    //            accumulated pages are memoized together — a retry refetches at
    //            most 5 list pages, and replays reuse the same result. The
    //            branch is injected so trigger conditions can match on
    //            git_branch. ─────────────────────────────────────────────────
    const commitBackfill = await step.run("fetch-commits", async () => {
      const since = new Date(
        Date.now() - syncDepthDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      const maxPages = Math.ceil(MAX_COMMITS_BACKFILL / COMMITS_PER_PAGE);
      const collected: unknown[] = [];
      let cappedAtMax = false;
      for (let page = 1; page <= maxPages; page++) {
        const pageItems = await ghList(
          `${repoBase}/commits?sha=${encodeURIComponent(defaultBranch)}&since=${encodeURIComponent(since)}&per_page=${COMMITS_PER_PAGE}&page=${page}`,
          accessToken,
        );
        collected.push(...pageItems);
        // A short page means the window is exhausted; a full final page means
        // more history exists inside the window beyond the cap.
        if (pageItems.length < COMMITS_PER_PAGE) break;
        if (page === maxPages) cappedAtMax = true;
      }
      return {
        commits: collected.slice(0, MAX_COMMITS_BACKFILL),
        cappedAtMax,
        since,
      };
    });

    const commits = commitBackfill.commits;
    // Never truncate silently — the operator must know the graph holds partial
    // history for this window.
    if (commitBackfill.cappedAtMax) {
      logger.warn(
        {
          connectionId,
          orgId,
          owner,
          repo,
          cap: MAX_COMMITS_BACKFILL,
          syncDepthDays,
          since: commitBackfill.since,
        },
        "ingestion-github-initial-sync: commit backfill capped at MAX_COMMITS_BACKFILL — older commits inside the sync window were not ingested",
      );
    }
    const commitsWithBranch = commits.map((c) => ({
      ...asRecord(c),
      git_branch: defaultBranch,
    }));
    await dispatchEntities("commits", "commit", commitsWithBranch);

    logger.info(
      {
        connectionId,
        orgId,
        owner,
        repo,
        prCount: pulls.length,
        issueCount: issues.length,
        releaseCount: releases.length,
        commitCount: commitsWithBranch.length,
      },
      "ingestion-github-initial-sync: fetched provider records",
    );

    // ── Step 8: Upsert the SourceConnection meta-node in Neo4j ───────────────
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

    // ── Step 9: Mark connection as connected ──────────────────────────────────
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

    logger.info(
      { connectionId, orgId, owner, repo },
      "ingestion-github-initial-sync: completed",
    );

    return {
      connectionId,
      owner,
      repo,
      entityCount:
        1 +
        pulls.length +
        issues.length +
        releases.length +
        commitsWithBranch.length,
    };
  },
);
