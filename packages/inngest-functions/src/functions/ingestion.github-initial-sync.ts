import { NonRetriableError } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { upsertSourceConnectionMeta } from "@oxagen/ingestion/mutations";
import {
  fetchConnectionAccessToken,
  resolveCanonicalHead,
  fetchTreeBySha,
  deriveScopes,
  isParseableFile,
  stageGeneration,
  EXCLUDED_PREFIXES,
  MAX_FILES,
  PROJECTION_PARSER_VERSION,
} from "../lib/github-projection";
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
// How many of the most recent commits to fan out commit-file detail fetches for.
// Each commit requires one extra GitHub API call; 100 stays conservative
// relative to the 5000 req/hr OAuth rate limit while covering the backfilled
// history window far deeper than the previous cap of 20.
const MAX_COMMIT_FILE_SYNC = 100;

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
 *   1. resolves an access token and the repo's real default branch, then pins
 *      the sync to the IMMUTABLE commit + tree SHA at that ref
 *      (resolveCanonicalHead) — never a moving branch name (spec §"Canonical-ref
 *      policy", §"GitHub projection lifecycle");
 *   2. backfills domain entities — the repository itself plus recent pull
 *      requests, issues, and releases (first page each) and commit history
 *      date-bounded by syncDepthDays (paginated, hard-capped at
 *      MAX_COMMITS_BACKFILL, pinned to the resolved commit SHA) — by emitting one
 *      "ingestion/entity.received" per record;
 *   3. fetches the tree BY ITS SHA, derives a stable code-scope topology, and
 *      stages a projection generation ('building') in Postgres;
 *   4. fans out one extended "ingestion/github.parse-file" per parseable source
 *      file (carrying its generation + code-scope binding), so the projection
 *      completes and activates atomically once every file reports done;
 *   5. upserts the SourceConnection meta-node and marks the connection connected.
 *
 * Concurrency is limited to 2 syncs per org.
 */
export const [ingestionGithubInitialSync] = createFunction(
  {
    id: "ingestion-github-initial-sync",
    retries: 3,
    concurrency: { limit: 2, key: "event.data.orgId" },
  },
  { event: "ingestion/github.initial-sync" },
  async ({ event, step }) => {
    const { connectionId, orgId, workspaceId, owner, repo, syncDepthDays: syncDepthDaysRaw } =
      event.data as {
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
      typeof syncDepthDaysRaw === "number" && Number.isFinite(syncDepthDaysRaw) && syncDepthDaysRaw > 0
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

    // ── Step 1: Resolve the connection's GitHub access token ──────────────────
    const accessToken = await step.run("fetch-access-token", () =>
      fetchConnectionAccessToken(connectionId, orgId),
    );

    // ── Step 2: Fetch repository metadata (real default branch + provider id) ──
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
    // Provider's IMMUTABLE repository id — stable across owner/name renames.
    const providerRepoId =
      repoMeta["id"] != null ? String(repoMeta["id"]) : `${owner}/${repo}`;

    // ── Step 2b: Pin the sync to the immutable commit + tree SHA at the ref ────
    const head = await step.run("resolve-canonical-head", () =>
      resolveCanonicalHead(accessToken, owner, repo, defaultBranch),
    );

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

    // ── Step 7: Backfill commit history, date-bounded by syncDepthDays and
    //            PINNED TO THE RESOLVED COMMIT SHA (spec: the immutable snapshot
    //            identity, not the moving branch name). Paginated up to a hard
    //            MAX_COMMITS_BACKFILL safety cap. ─────────────────────────────
    const commitBackfill = await step.run("fetch-commits", async () => {
      const since = new Date(Date.now() - syncDepthDays * 24 * 60 * 60 * 1000).toISOString();
      const maxPages = Math.ceil(MAX_COMMITS_BACKFILL / COMMITS_PER_PAGE);
      const collected: unknown[] = [];
      let cappedAtMax = false;
      for (let page = 1; page <= maxPages; page++) {
        const pageItems = await ghList(
          `${repoBase}/commits?sha=${encodeURIComponent(head.commitSha)}&since=${encodeURIComponent(since)}&per_page=${COMMITS_PER_PAGE}&page=${page}`,
          accessToken,
        );
        collected.push(...pageItems);
        // A short page means the window is exhausted; a full final page means
        // more history exists inside the window beyond the cap.
        if (pageItems.length < COMMITS_PER_PAGE) break;
        if (page === maxPages) cappedAtMax = true;
      }
      return { commits: collected.slice(0, MAX_COMMITS_BACKFILL), cappedAtMax, since };
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
    const commitsWithBranch = commits.map((c) => ({ ...asRecord(c), git_branch: defaultBranch }));
    await dispatchEntities("commits", "commit", commitsWithBranch);

    // ── Step 7b: Fan out commit-file detail fetches (bounded) ─────────────────
    // For each of the most recent MAX_COMMIT_FILE_SYNC commits from the
    // backfilled window (GitHub lists newest first), emit one
    // "ingestion/github.commit-files" event so the commit-files function can fetch
    // per-commit file lists and write (:Commit)-[:MODIFIED]->(:SourceFile) edges.
    const commitsForFileSyncRaw = commits.slice(0, MAX_COMMIT_FILE_SYNC);
    if (commits.length > MAX_COMMIT_FILE_SYNC) {
      logger.info(
        {
          connectionId,
          orgId,
          owner,
          repo,
          total: commits.length,
          cap: MAX_COMMIT_FILE_SYNC,
        },
        "ingestion-github-initial-sync: commit-file fan-out capped — older commits will not have :MODIFIED edges",
      );
    }

    // Extract the SHA for each commit. The GitHub list endpoint puts the SHA at
    // the top level of each commit object.
    const commitShas = commitsForFileSyncRaw
      .map((c) => {
        const rec = asRecord(c);
        return typeof rec["sha"] === "string" ? rec["sha"] : null;
      })
      .filter((s): s is string => s !== null);

    if (commitShas.length > 0) {
      for (let i = 0; i < commitShas.length; i += BATCH_SIZE) {
        const batch = commitShas.slice(i, i + BATCH_SIZE);
        await step.sendEvent(
          `dispatch-commit-files-batch-${i}`,
          batch.map((commitSha) => ({
            name: "ingestion/github.commit-files" as const,
            data: {
              connectionId,
              orgId,
              workspaceId,
              owner,
              repo,
              sha: commitSha,
            },
          })),
        );
      }
    }

    // ── Step 8: Fetch the tree BY ITS IMMUTABLE SHA, derive code scopes, and
    //            select parseable files. Everything is computed inside the step
    //            so the memoized state stays compact (parseable files capped at
    //            MAX_FILES; scopes bounded). ───────────────────────────────────
    const treeProjection = await step.run("fetch-repo-tree", async () => {
      const { entries, truncated } = await fetchTreeBySha(
        accessToken,
        owner,
        repo,
        head.treeSha,
      );
      // Derive scopes from blob paths, EXCLUDING the noisy prefixes (node_modules,
      // dist, …) so they never become junk scopes — but keeping non-parseable
      // manifests (package.json, go.mod, …) so their directories become package
      // scopes.
      const scopePaths = entries
        .filter((e) => e.type === "blob")
        .map((e) => e.path)
        .filter((p) => !EXCLUDED_PREFIXES.some((pfx) => p.startsWith(pfx)));
      const { scopes, scopeKeyByPath } = deriveScopes(scopePaths);
      const parseable = entries
        .filter(isParseableFile)
        .slice(0, MAX_FILES)
        .map((f) => ({
          sha: f.sha,
          path: f.path,
          scopeKey: scopeKeyByPath[f.path] as string,
        }));
      return { parseable, scopes, truncated };
    });

    const parseableFiles = treeProjection.parseable;

    // ── Step 8b: Stage the projection generation in Postgres (canonical truth) ─
    const staged = await step.run("stage-generation", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        stageGeneration({
          orgId,
          workspaceId,
          provider: "github",
          providerRepoId,
          owner,
          name: repo,
          installationId: null, // initial sync uses the OAuth token, not the App
          sourceConnectionId: connectionId,
          defaultRef: `refs/heads/${defaultBranch}`,
          commitSha: head.commitSha,
          treeSha: head.treeSha,
          parentShas: head.parentShas,
          observedHeadSha: head.commitSha,
          filesTotal: parseableFiles.length,
          truncated: treeProjection.truncated,
          parserVersion: PROJECTION_PARSER_VERSION,
          scopes: treeProjection.scopes,
          snapshotSource: "provider_observed",
        }),
      ),
    );

    logger.info(
      {
        connectionId,
        orgId,
        owner,
        repo,
        commitSha: head.commitSha,
        treeSha: head.treeSha,
        generationId: staged.generationId,
        alreadyExists: staged.alreadyExists,
        fileCount: parseableFiles.length,
        prCount: pulls.length,
        issueCount: issues.length,
        releaseCount: releases.length,
        commitCount: commitsWithBranch.length,
      },
      "ingestion-github-initial-sync: staged generation + fetched domain records",
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
              parseableFiles.length +
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

    // ── Step 10: Fan out extended parse-file events per parseable file ────────
    // Skip re-fan-out when the generation for this exact commit was already
    // staged (dedupe-by-after-sha) — the original run's fan-out drives it.
    if (!staged.alreadyExists) {
      const batches: Array<typeof parseableFiles> = [];
      for (let i = 0; i < parseableFiles.length; i += BATCH_SIZE) {
        batches.push(parseableFiles.slice(i, i + BATCH_SIZE));
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
              repositoryId: staged.repositoryId,
              generationId: staged.generationId,
              commitSha: head.commitSha,
              treeSha: head.treeSha,
              scopeKey: file.scopeKey,
              codeScopeId: staged.codeScopeIdByKey[file.scopeKey] as string,
            },
          })),
        );
      }
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
    // file into an application domain and stamps `domain` on graph nodes.
    if (parseableFiles.length > 0 && !staged.alreadyExists) {
      await step.sendEvent("infer-domains", {
        name: "ingestion/github.infer-domains" as const,
        data: {
          filePaths: parseableFiles.map((f) => f.path),
          orgId,
          workspaceId,
          connectionId,
          owner,
          repo,
        },
      });
    }

    logger.info(
      { connectionId, orgId, owner, repo, fileCount: parseableFiles.length },
      "ingestion-github-initial-sync: completed",
    );

    return {
      connectionId,
      owner,
      repo,
      commitSha: head.commitSha,
      treeSha: head.treeSha,
      generationId: staged.generationId,
      alreadyExists: staged.alreadyExists,
      fileCount: parseableFiles.length,
      entityCount: 1 + pulls.length + issues.length + releases.length + commitsWithBranch.length,
    };
  },
);
