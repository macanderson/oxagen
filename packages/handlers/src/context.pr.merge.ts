// merge_context_pr (ADR-061; MC spec §10.3 steps 3-4). Refused until every
// check passed; refused unless the caller is a reviewer the governance mode
// allows (context.steering.policy.ts), read from governance.toml on the
// production branch at merge time. The PR is merged on GitHub first; only a
// merge GitHub confirmed publishes the record into the registry, appends the
// promotion event to the hash-chained ledger — the ledger length is the
// workspace's steering version — and emits `steering.published`.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { contextPrMerge } from "@oxagen/oxagen/contracts/context.pr.merge";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import {
  GOVERNANCE_PATH,
  mergeRefusal,
  parseGovernanceMode,
} from "./context.steering.policy";
import { logger } from "./logger";
import { sha256Hex } from "./registry-digest";

export function createMergeContextPrHandler(
  deps: SteeringDeps,
): CapabilityHandler<typeof contextPrMerge> {
  return async (input, ctx) => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const row = await deps.store.findProposal(scope, input.proposalId);
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "proposal_not_found",
        message: `No proposal ${input.proposalId} in this workspace`,
      });
    }
    if (row.status === "merged") {
      throw new HandlerError({
        code: "conflict",
        reason: "already_merged",
        message: `${row.prUrl ?? row.publicId} is already merged`,
      });
    }
    if (row.status !== "checks_passed") {
      throw new HandlerError({
        code: "conflict",
        reason: "checks_not_passed",
        message: `Merge is blocked until every check passes (${row.status})`,
      });
    }
    if (
      row.prNumber === null ||
      !row.repository ||
      !row.branch ||
      !row.path ||
      !row.stampedRecordId ||
      !row.recordHash
    ) {
      throw new HandlerError({
        code: "conflict",
        reason: "pr_not_recorded",
        message: `Proposal ${row.publicId} has no recorded pull request`,
      });
    }

    const repo = await deps.github.resolveRepository(scope);
    const mode = parseGovernanceMode(
      await deps.github.readFile(repo, GOVERNANCE_PATH, repo.defaultBranch),
    );
    if (typeof mode !== "string") {
      throw new HandlerError({
        code: "conflict",
        reason: "governance_unreadable",
        message: mode.error,
      });
    }
    const userId = ctx.userId ?? null;
    const refusal = mergeRefusal(
      mode,
      {
        userId,
        orgRole: userId ? await deps.roles.orgRole(ctx.orgId, userId) : null,
        workspaceRole: userId
          ? await deps.roles.workspaceRole(ctx.orgId, ctx.workspaceId, userId)
          : null,
      },
      row.createdByUserId,
    );
    if (refusal) {
      throw new HandlerError({
        code: "forbidden",
        reason: refusal,
        message: `Governance mode ${mode} does not let this caller merge (${refusal})`,
      });
    }

    // The published body is the file as it sits on the branch about to merge.
    const body = await deps.github.readFile(repo, row.path, row.branch);
    if (body === null) {
      throw new HandlerError({
        code: "conflict",
        reason: "record_file_missing",
        message: `${row.path} is not on ${row.branch}`,
      });
    }

    const merged = await deps.github.mergePullRequest(repo, {
      number: row.prNumber,
      commitTitle: `steering: publish ${row.lineageId} (#${row.prNumber})`,
    });
    const mergedAt = deps.now();
    const result = await deps.store.publishMerge({
      scope,
      proposal: row,
      body,
      checksum: sha256Hex(body),
      commitSha: merged.sha,
      path: row.path,
      mergedAt,
      mergedByUserId: userId,
      policyVersion: `governance:${mode}`,
    });

    deps.emit({
      eventType: "steering.published",
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      capability: "merge_context_pr",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });
    logger.info(
      {
        proposalId: row.publicId,
        lineageId: row.lineageId,
        pr: row.prUrl,
        commit: merged.sha,
        bundleVersion: result.ledgerBefore + 1,
        workspaceId: ctx.workspaceId,
      },
      "context.pr.merge: published record",
    );

    return {
      proposalId: row.publicId,
      status: "merged",
      record: {
        id: result.recordPublicId,
        lineageId: row.lineageId,
        version: result.version,
        path: row.path,
      },
      mergedCommit: merged.sha,
      promotionEvent: {
        id: result.promotion.publicId,
        seq: result.promotion.seq,
        chainDigest: result.promotion.chainDigest,
      },
      bundleVersion: {
        before: result.ledgerBefore,
        after: result.ledgerBefore + 1,
      },
    };
  };
}

export const mergeContextPrHandler = createMergeContextPrHandler(
  steeringDeps(),
);
