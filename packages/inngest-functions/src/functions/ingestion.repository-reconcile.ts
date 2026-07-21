import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import {
  fetchConnectionAccessToken,
  resolveCanonicalHead,
} from "../lib/github-projection";
import { logger } from "../logger";

/**
 * Periodic canonical-ref reconciliation (spec §"GitHub projection lifecycle":
 * "Use a periodic ref reconciliation job as insurance against lost, duplicated,
 * or out-of-order webhooks").
 *
 * Hourly, for every governed repository whose source connection is still
 * `connected`:
 *   1. resolve the AUTHORITATIVE head at the repository's discovered default
 *      ref (never the moving branch name as snapshot identity — the head's
 *      commit SHA is the identity);
 *   2. if that commit differs from projected_head_sha AND no generation is
 *      already 'building' for the repository, emit a SYNTHETIC
 *      `ingestion/repository.ref-updated` carrying deliveryId
 *      `reconcile:{providerRepoId}:{afterSha}`.
 *
 * That delivery id is what makes an hourly repeat free: it lands in
 * repository_ref_observations under the UNIQUE delivery_id constraint, so the
 * second and every later reconcile of the same head is a no-op inside
 * repository-ref-updated. beforeSha is the currently projected head, so a
 * repository that is merely a few commits behind still takes the cheap delta
 * path rather than a full tree reconcile.
 *
 * The 'building' guard means a generation WEDGED in 'building' (e.g. a file
 * whose parse never reported done) is not retried by this job — it is the
 * spec'd behavior, and unwedging is an operator action, not an hourly retry
 * storm.
 *
 * Postgres access is withSystemDb: this is an unattended cross-tenant sweep
 * with no ambient tenant scope, exactly like ingestion-poll-scheduler. Every
 * emitted event carries the row's own orgId/workspaceId, so the tenant-scoped
 * work happens downstream in repository-ref-updated.
 */

/** Repositories inspected per hourly tick — bounds GitHub API fan-out. */
const MAX_REPOSITORIES_PER_TICK = 200;

export const [ingestionRepositoryReconcile] = createFunction(
  {
    id: "ingestion-repository-reconcile",
    retries: 2,
  },
  { cron: "0 * * * *" },
  async ({ step }) => {
    // ── Step 1: Candidate repositories — live connection, no build in flight ──
    // The NOT EXISTS is evaluated in SQL so a repository mid-build is never even
    // fetched from GitHub.
    const candidates = await step.run("load-candidate-repositories", () =>
      withSystemDb(async (tx) => {
        const rows = await tx.execute(sql`
          SELECT r.id,
                 r.org_id,
                 r.workspace_id,
                 r.provider_repo_id,
                 r.owner,
                 r.name,
                 r.installation_id,
                 r.source_connection_id,
                 r.default_ref,
                 r.projected_head_sha
          FROM   ingestion.code_repositories r
          JOIN   ingestion.source_connections sc
                 ON sc.id = r.source_connection_id
          WHERE  r.provider    = 'github'
          AND    sc.status     = 'connected'
          AND    sc.deleted_at IS NULL
          AND    NOT EXISTS (
                   SELECT 1
                   FROM   ingestion.projection_generations g
                   WHERE  g.repository_id = r.id
                   AND    g.status        = 'building'
                 )
          ORDER  BY r.updated_at ASC
          LIMIT  ${MAX_REPOSITORIES_PER_TICK}
        `);
        return Array.from(rows) as Array<{
          id: string;
          org_id: string;
          workspace_id: string;
          provider_repo_id: string;
          owner: string;
          name: string;
          installation_id: string | null;
          source_connection_id: string;
          default_ref: string;
          projected_head_sha: string | null;
        }>;
      }),
    );

    if (candidates.length === 0) {
      return { inspected: 0, drifted: 0 };
    }

    // ── Step 2: Resolve each repository's authoritative head ──────────────────
    // One step per repository so a single unreachable repo (revoked token,
    // deleted repo) is memoized as a skip instead of failing the whole tick.
    const drifted: Array<{
      repo: (typeof candidates)[number];
      commitSha: string;
    }> = [];

    for (const repo of candidates) {
      const head = await step.run(`resolve-head-${repo.id}`, async () => {
        try {
          const token = await fetchConnectionAccessToken(
            repo.source_connection_id,
            repo.org_id,
          );
          const resolved = await resolveCanonicalHead(
            token,
            repo.owner,
            repo.name,
            repo.default_ref,
          );
          return { commitSha: resolved.commitSha };
        } catch (err) {
          logger.warn(
            {
              err,
              orgId: repo.org_id,
              providerRepoId: repo.provider_repo_id,
              owner: repo.owner,
              repo: repo.name,
            },
            "ingestion-repository-reconcile: could not resolve canonical head",
          );
          return null;
        }
      });

      if (!head) continue;
      if (head.commitSha === repo.projected_head_sha) continue;
      drifted.push({ repo, commitSha: head.commitSha });
    }

    if (drifted.length === 0) {
      return { inspected: candidates.length, drifted: 0 };
    }

    // ── Step 3: Emit one synthetic ref-updated per drifted repository ─────────
    // deliveryId is keyed on the target head, so re-running this hour after hour
    // against an unchanged head inserts nothing new and stops at the dedupe.
    await step.sendEvent(
      "dispatch-reconcile-ref-updates",
      drifted.map(({ repo, commitSha }) => ({
        name: "ingestion/repository.ref-updated" as const,
        data: {
          orgId: repo.org_id,
          workspaceId: repo.workspace_id,
          connectionId: repo.source_connection_id,
          installationId: repo.installation_id ?? "",
          providerRepoId: repo.provider_repo_id,
          owner: repo.owner,
          repo: repo.name,
          ref: repo.default_ref,
          // The projected head IS the delta base — a repository a few commits
          // behind reconciles via `compare` rather than a whole-tree rebuild.
          beforeSha: repo.projected_head_sha,
          afterSha: commitSha,
          forced: false,
          deleted: false,
          deliveryId: `reconcile:${repo.provider_repo_id}:${commitSha}`,
          observedAt: new Date().toISOString(),
        },
      })),
    );

    logger.info(
      { inspected: candidates.length, drifted: drifted.length },
      "ingestion-repository-reconcile: dispatched synthetic ref updates",
    );

    return { inspected: candidates.length, drifted: drifted.length };
  },
);
