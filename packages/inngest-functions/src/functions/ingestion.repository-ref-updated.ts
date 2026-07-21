import { createFunction } from "../create-function";
import { withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { removeCanonicalFiles } from "@oxagen/ontology";
import {
  fetchConnectionAccessToken,
  resolveCanonicalHead,
  fetchTreeBySha,
  fetchCompare,
  classifyCompareFiles,
  deriveScopes,
  isParseableFile,
  stageGeneration,
  activateGenerationIfComplete,
  EXCLUDED_PREFIXES,
  MAX_FILES,
  PROJECTION_PARSER_VERSION,
} from "../lib/github-projection";
import { logger } from "../logger";

// Events per step.sendEvent batch call.
const BATCH_SIZE = 50;

/**
 * Repository ref-updated Inngest function.
 *
 * Triggered by "ingestion/repository.ref-updated", emitted per resolved
 * connection by the GitHub App webhook on a `push` and by the hourly reconcile
 * cron. The webhook is a TRIGGER, not the source of truth (spec §"Push to the
 * canonical ref"):
 *   1. Record the delivery in repository_ref_observations, ON CONFLICT
 *      (delivery_id) DO NOTHING → a duplicate/out-of-order delivery STOPS here.
 *   2. Advance observed_head_sha when the update is on the canonical ref.
 *   3. Deletions and NONCANONICAL refs never mutate shared topology → STOP.
 *   4. Re-fetch the AUTHORITATIVE head from GitHub (even if it advanced past
 *      afterSha) — the webhook only tells us to look.
 *   5. Fetch the tree by its SHA, derive scopes, and decide delta vs full
 *      reconcile: a clean delta only when projected_head_sha === beforeSha and
 *      the push was not forced; otherwise reconcile the whole tree.
 *   6. Stage the generation (dedupe-by-after-sha → STOP), remove canonical files
 *      for deletions/renames, then fan out parse-file per file. A zero-file
 *      generation (deletions only) activates immediately.
 *
 * Concurrency is keyed per repository at limit 1 so two pushes to one repo
 * serialize (Inngest's `limit` is PER distinct key value). The dedupe-by-
 * after-sha in stageGeneration and the repository-row lock in
 * activateGenerationIfComplete are the actual correctness guards; serializing
 * here just stops two generations of the same repo racing GitHub's API.
 */
export const [ingestionRepositoryRefUpdated] = createFunction(
  {
    id: "ingestion-repository-ref-updated",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.providerRepoId" },
  },
  { event: "ingestion/repository.ref-updated" },
  async ({ event, step }) => {
    const {
      orgId,
      workspaceId,
      connectionId,
      installationId,
      providerRepoId,
      owner,
      repo,
      ref,
      beforeSha,
      afterSha,
      forced,
      deleted,
      deliveryId,
      observedAt,
    } = event.data as {
      orgId: string;
      workspaceId: string;
      connectionId: string;
      installationId: string;
      providerRepoId: string;
      owner: string;
      repo: string;
      ref: string;
      beforeSha: string | null;
      afterSha: string | null;
      forced: boolean;
      deleted: boolean;
      deliveryId: string;
      observedAt: string;
    };

    // ── Step 1: Record the observation (dedupe) + load the governed repo ───────
    const obs = await step.run("record-observation", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb(async (tx) => {
          const repoRows = Array.from(
            await tx.execute(sql`
              SELECT id, default_ref, projected_head_sha
              FROM ingestion.code_repositories
              WHERE org_id = ${orgId}::uuid
                AND provider = 'github'
                AND provider_repo_id = ${providerRepoId}
              LIMIT 1
            `),
          ) as Array<{
            id: string;
            default_ref: string;
            projected_head_sha: string | null;
          }>;
          // No governed repository row yet (push before the initial sync landed).
          // The reconcile cron / initial sync will establish it; drop this trigger.
          if (!repoRows[0]) return { stop: "no_repository" as const };
          const repoRow = repoRows[0];

          const inserted = Array.from(
            await tx.execute(sql`
              INSERT INTO ingestion.repository_ref_observations
                (org_id, workspace_id, repository_id, ref, before_sha, after_sha,
                 forced, deleted, delivery_id, observed_at)
              VALUES
                (${orgId}::uuid, ${workspaceId}::uuid, ${repoRow.id}::uuid, ${ref},
                 ${beforeSha}, ${afterSha}, ${forced}, ${deleted}, ${deliveryId},
                 COALESCE(${observedAt ?? null}::timestamptz, NOW()))
              ON CONFLICT (delivery_id) DO NOTHING
              RETURNING id
            `),
          ) as Array<{ id: string }>;
          // Duplicate/out-of-order delivery — already observed.
          if (!inserted[0]) return { stop: "duplicate_delivery" as const };

          // Advance the observed head only when this update is on the canonical
          // ref (freshness = observed_head_sha vs projected_head_sha).
          if (!deleted && ref === repoRow.default_ref && afterSha) {
            await tx.execute(sql`
              UPDATE ingestion.code_repositories
              SET observed_head_sha = ${afterSha}, updated_at = NOW()
              WHERE id = ${repoRow.id}::uuid
            `);
          }

          return {
            stop: null,
            repositoryId: repoRow.id,
            defaultRef: repoRow.default_ref,
            projectedHeadSha: repoRow.projected_head_sha,
          };
        }),
      ),
    );

    if (obs.stop) {
      logger.info(
        {
          orgId,
          workspaceId,
          providerRepoId,
          ref,
          deliveryId,
          reason: obs.stop,
        },
        "ingestion-repository-ref-updated: stopped early",
      );
      return { stopped: obs.stop };
    }

    // ── Step 2: Canonical-ref gate — noncanonical channels never mutate the
    //            shared topology (spec §"Noncanonical branch or PR activity"). ──
    if (deleted || ref !== obs.defaultRef) {
      logger.info(
        {
          orgId,
          workspaceId,
          providerRepoId,
          ref,
          defaultRef: obs.defaultRef,
          deleted,
        },
        "ingestion-repository-ref-updated: noncanonical ref — no shared-topology mutation",
      );
      return { stopped: "noncanonical_ref" };
    }

    // ── Step 3: Access token ──────────────────────────────────────────────────
    const token = await step.run("fetch-token", () =>
      fetchConnectionAccessToken(connectionId, orgId),
    );

    // ── Step 4: Re-fetch the AUTHORITATIVE head (webhook is only a trigger) ────
    const head = await step.run("resolve-head", () =>
      resolveCanonicalHead(token, owner, repo, obs.defaultRef),
    );

    // ── Step 5: Fetch tree by SHA, derive scopes, and plan delta vs full ───────
    const plan = await step.run("plan-projection", async () => {
      const { entries, truncated } = await fetchTreeBySha(
        token,
        owner,
        repo,
        head.treeSha,
      );
      const scopePaths = entries
        .filter((e) => e.type === "blob")
        .map((e) => e.path)
        .filter((p) => !EXCLUDED_PREFIXES.some((pfx) => p.startsWith(pfx)));
      const { scopes, scopeKeyByPath } = deriveScopes(scopePaths);

      // Delta only when our last projection sat exactly at the push base and the
      // push was not forced; otherwise reconcile the entire target tree.
      const canDelta =
        obs.projectedHeadSha != null &&
        beforeSha != null &&
        obs.projectedHeadSha === beforeSha &&
        !forced;

      // Only fan out files whose path resolved to a derived scope. Every
      // parseable path in the target tree does; anything else (a compare entry
      // that vanished between the compare and the tree read) would stage a file
      // with no code_scopes row, so drop it rather than emit an undefined
      // codeScopeId.
      const scoped = (files: Array<{ path: string; sha: string }>) =>
        files.filter((f) => scopeKeyByPath[f.path] !== undefined);

      if (canDelta && beforeSha) {
        const compareFiles = await fetchCompare(
          token,
          owner,
          repo,
          beforeSha,
          head.commitSha,
        );
        const { fanOut, removed } = classifyCompareFiles(compareFiles);
        return {
          mode: "delta" as const,
          scopes,
          scopeKeyByPath,
          truncated,
          fanOut: scoped(fanOut).slice(0, MAX_FILES),
          removed,
        };
      }

      // Full reconcile: re-project the entire target tree. NOTE: this branch
      // removes nothing — a file deleted since the last projection keeps its
      // stale :SourceFile node until a delta push or a re-sync retires it. The
      // spec defines full reconcile as "reconcile the exact target tree" and a
      // commit-SHA-based sweep here would wrongly delete the untouched files a
      // DELTA generation legitimately leaves at an older commitSha.
      const fanOut = entries
        .filter(isParseableFile)
        .map((f) => ({ path: f.path, sha: f.sha }));
      return {
        mode: "full" as const,
        scopes,
        scopeKeyByPath,
        truncated,
        fanOut: scoped(fanOut).slice(0, MAX_FILES),
        removed: [] as string[],
      };
    });

    // ── Step 6: Stage the generation (dedupe-by-after-sha) ────────────────────
    const staged = await step.run("stage-generation", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        stageGeneration({
          orgId,
          workspaceId,
          provider: "github",
          providerRepoId,
          owner,
          name: repo,
          installationId,
          sourceConnectionId: connectionId,
          defaultRef: obs.defaultRef,
          commitSha: head.commitSha,
          treeSha: head.treeSha,
          parentShas: head.parentShas,
          observedHeadSha: afterSha ?? head.commitSha,
          filesTotal: plan.fanOut.length,
          truncated: plan.truncated,
          parserVersion: PROJECTION_PARSER_VERSION,
          scopes: plan.scopes,
          snapshotSource: "provider_observed",
        }),
      ),
    );

    if (staged.alreadyExists) {
      logger.info(
        {
          orgId,
          workspaceId,
          providerRepoId,
          commitSha: head.commitSha,
          generationId: staged.generationId,
        },
        "ingestion-repository-ref-updated: snapshot already staged — skipping",
      );
      return {
        stopped: "already_staged",
        generationId: staged.generationId,
        mode: plan.mode,
      };
    }

    // ── Step 7: Remove canonical files for deletions/renames (delta only) ──────
    if (plan.removed.length > 0) {
      await step.run("remove-canonical-files", () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          removeCanonicalFiles({ owner, repo, paths: plan.removed }),
        ),
      );
    }

    // ── Step 8: Fan out parse-file, or activate immediately when empty ────────
    if (plan.fanOut.length === 0) {
      // Deletions-only (or nothing parseable changed) — no file will report done,
      // so drive the completion gate directly.
      await step.run("activate-empty-generation", () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          activateGenerationIfComplete(staged.generationId),
        ),
      );
    } else {
      const batches: Array<typeof plan.fanOut> = [];
      for (let i = 0; i < plan.fanOut.length; i += BATCH_SIZE) {
        batches.push(plan.fanOut.slice(i, i + BATCH_SIZE));
      }
      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx]!;
        await step.sendEvent(
          `dispatch-files-batch-${batchIdx}`,
          batch.map((file) => {
            // Non-null by construction: plan.fanOut was filtered to paths that
            // have a scopeKeyByPath entry, and every derived scope key was
            // inserted into code_scopes by stageGeneration.
            const scopeKey = plan.scopeKeyByPath[file.path]!;
            return {
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
                scopeKey,
                codeScopeId: staged.codeScopeIdByKey[scopeKey] as string,
              },
            };
          }),
        );
      }
    }

    logger.info(
      {
        orgId,
        workspaceId,
        providerRepoId,
        commitSha: head.commitSha,
        generationId: staged.generationId,
        mode: plan.mode,
        fannedOut: plan.fanOut.length,
        removed: plan.removed.length,
      },
      "ingestion-repository-ref-updated: staged projection generation",
    );

    return {
      generationId: staged.generationId,
      mode: plan.mode,
      fannedOut: plan.fanOut.length,
      removed: plan.removed.length,
    };
  },
);
