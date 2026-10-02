"use server";
// The steering PR writes (#2961; ADR-061), each through the kernel seam for the
// workspace viewer the URL names. Every contract is `noBillingGate`.
// open_steering_pr and dismiss_proposal gate the acting user's role in their
// handlers (INV-29); merge_steering_pr gates the signed-in reviewer the
// governance mode names, and revert_steering_pr gates the acting user by the
// same mode. A refusal comes back as `denied` or `conflict` with
// the handler's reason as its code, and nothing changed.
import { agentMemoryUpdate } from "@oxagen/oxagen/contracts/agent.memory.update";
import { contextGovernanceModeSet } from "@oxagen/oxagen/contracts/context.governance_mode.set";
import { steeringMemoryPrRecordDrop } from "@oxagen/oxagen/contracts/steering.memory_pr_records.drop";
import { steeringPrApprove } from "@oxagen/oxagen/contracts/steering.pr.approve";
import { steeringPrMerge } from "@oxagen/oxagen/contracts/steering.pr.merge";
import { steeringPrMergeWithoutReview } from "@oxagen/oxagen/contracts/steering.pr.merge_without_review";
import { steeringPrOpen } from "@oxagen/oxagen/contracts/steering.pr.open";
import { steeringPrRefresh } from "@oxagen/oxagen/contracts/steering.pr.refresh";
import { steeringPrRevert } from "@oxagen/oxagen/contracts/steering.pr.revert";
import { steeringPrRestoreManagedBlock } from "@oxagen/oxagen/contracts/steering.pr.restore_managed_block";
import { steeringProposalDismiss } from "@oxagen/oxagen/contracts/steering.proposal.dismiss";
import { governanceModeSchema } from "@oxagen/oxagen/contracts/context.steering.shared";
import { workspaceSettingsWrite } from "@oxagen/oxagen/contracts/workspace.settings.write";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** Opens the proposal's steering PR and runs its six checks, or re-runs them on the pull request already open; returns where the machine stopped. */
export async function openSteeringPr(
  org: string,
  ws: string,
  proposalId: string,
): Promise<
  ActionResult<{ status: ContractOutput<typeof steeringPrOpen>["status"] }>
> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, steeringPrOpen, { proposalId });
  return result.ok
    ? { ok: true, value: { status: result.value.status } }
    : result;
}

/** Merges the pull request once every check passed; merge publishes the record. */
export async function mergeSteeringPr(
  org: string,
  ws: string,
  proposalId: string,
): Promise<ActionResult<{ commit: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, steeringPrMerge, { proposalId });
  return result.ok
    ? { ok: true, value: { commit: result.value.mergedCommit } }
    : result;
}

/** What the revert dialog shows once `revert_steering_pr` opened the revert PR. */
export type RevertOpened = {
  number: number;
  url: string;
  branch: string;
  /** The Oxagen steering check on the revert's head; null when none was reported. */
  check: "success" | "failure" | null;
};

/**
 * Opens a steering PR that undoes this merged one. The handler gates the
 * contract's roles and the governance mode's merge rule (INV-29). The revert
 * waits for its own review and merges nothing here.
 */
export async function revertSteeringPr(
  org: string,
  ws: string,
  proposalId: string,
): Promise<ActionResult<RevertOpened>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, steeringPrRevert, { proposalId });
  if (!result.ok) return result;
  const { pullRequest, check } = result.value;
  return {
    ok: true,
    value: {
      number: pullRequest.number,
      url: pullRequest.url,
      branch: pullRequest.branch,
      check,
    },
  };
}

/**
 * Closes the proposal without merging, with a reason when one is given; an
 * open pull request for it is closed on the host and its branch deleted
 * before the proposal moves. A blank reason records none.
 */
export async function dismissProposal(
  org: string,
  ws: string,
  proposalId: string,
  reason: string,
): Promise<ActionResult<{ status: "rejected" }>> {
  const ctx = await requireViewer(org, ws);
  const trimmed = reason.trim();
  const result = await kernelWrite(ctx, steeringProposalDismiss, {
    proposalId,
    ...(trimmed === "" ? {} : { reason: trimmed }),
  });
  return result.ok
    ? { ok: true, value: { status: result.value.status } }
    : result;
}

/**
 * Reads the steering PR from the host now and moves the proposal to the host's
 * state (#5077; ADR-184). Answers the host's state and whether anything
 * moved, so the page knows to draw again.
 */
export async function refreshSteeringPr(
  org: string,
  ws: string,
  proposalId: string,
): Promise<
  ActionResult<{
    changed: boolean;
    syncRequested: boolean;
    host: ContractOutput<typeof steeringPrRefresh>["host"];
  }>
> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, steeringPrRefresh, { proposalId });
  return result.ok
    ? {
        ok: true,
        value: {
          changed: result.value.changed,
          syncRequested: result.value.syncRequested,
          host: result.value.host,
        },
      }
    : result;
}

/**
 * Set one of the two steering-freshness gates for the workspace.
 *
 * One gate per call, as a patch. Two checkboxes that each resent both values
 * would let the second person to click overwrite the first person's change
 * with the value their page happened to be rendered with, and a governance
 * gate that silently switches back off is worse than one that was never
 * offered. `update_workspace_settings` merges the named member into the
 * stored block and leaves the other alone.
 *
 * The handler gates the role (INV-29): an org or workspace Owner or Admin
 * writes, anyone else is answered `denied` with nothing changed.
 */
export async function setSteeringGate(
  org: string,
  ws: string,
  gate: "autoSync" | "blockStaleRuns",
  enabled: boolean,
): Promise<ActionResult<{ autoSync: boolean; blockStaleRuns: boolean }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workspaceSettingsWrite, {
    steering: { [gate]: enabled },
  });
  return result.ok ? { ok: true, value: result.value.steering } : result;
}

/** What the governance dialog reports once `set_governance_mode` answered. */
export type GovernanceChanged = {
  /** `proposed` opened a pull request; `applied` committed under solo; `unchanged` wrote nothing. */
  outcome: "applied" | "proposed" | "unchanged";
  mode: "solo" | "team" | "regulated";
  repository: string;
  branch: string;
  /** The governance file the mode lives in for the repository's layout. */
  path: string;
  pullRequest: { number: number; htmlUrl: string } | null;
  /**
   * The governance proposal a reviewer lands from Proposals, when a steering
   * repository's change went to review (ADR-232). Null otherwise.
   */
  proposalId: string | null;
};

/**
 * Change the workspace's governance mode from the Steering header's chip
 * (roadmap pages/steering.md, `govmode`).
 *
 * The mode lives in the main repository's governance file, never in a
 * settings row (ADR-061 decision 1): `steering/governance.toml` in a steering
 * repository, `.oxagen/rules/governance.toml` in a legacy one. So this is a
 * write to that file: under `team` or `regulated` it opens a pull request
 * against the production branch, and under `solo` it lands. `applyImmediately` is never
 * sent from here, so no review is skipped from this dialog. The handler gates
 * the role (INV-29): an org Owner or Admin, or a workspace Owner or Admin,
 * writes; anyone else is answered `denied` with nothing changed.
 */
export async function setGovernanceMode(
  org: string,
  ws: string,
  mode: string,
): Promise<ActionResult<GovernanceChanged>> {
  // The dialog's pick reaches a contract enum, so an unknown one is refused
  // here rather than sent.
  const picked = governanceModeSchema.safeParse(mode);
  if (!picked.success) {
    return {
      ok: false,
      reason: "invalid",
      field: "mode",
      code: "invalid_input",
    };
  }
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, contextGovernanceModeSet, {
    mode: picked.data,
    applyImmediately: false,
  });
  if (!result.ok) return result;
  const {
    outcome,
    requestedMode,
    fullName,
    productionBranch,
    path,
    pullRequest,
    proposalId,
  } = result.value;
  return {
    ok: true,
    value: {
      outcome,
      mode: requestedMode,
      repository: fullName,
      branch: productionBranch,
      path,
      pullRequest:
        pullRequest === null
          ? null
          : { number: pullRequest.number, htmlUrl: pullRequest.htmlUrl },
      proposalId,
    },
  };
}

/**
 * Forget one memory from the Library's Memory shelf (roadmap
 * pages/steering-memory.md, `memforget`).
 *
 * Forgetting stops the assembler selecting the memory and touches no run.
 * It is `update_memory` setting the node's status to RETRACTED, never
 * `delete_memory`: a delete is a `DETACH DELETE` that takes the node's
 * citation edges with it, and those edges are how a run that carried the
 * memory still names it. Recall and list read ACTIVE nodes only, so a
 * retracted memory leaves the shelf and every agent's recall, while each
 * frame and each citation stays as it was recorded.
 *
 * The kernel gates the write on `update_memory`'s roles for the workspace
 * viewer the URL names: an org Owner or Admin, or a workspace Owner or
 * Member; anyone else is answered `denied` with nothing changed.
 */
export async function forgetMemory(
  org: string,
  ws: string,
  memoryRef: string,
): Promise<ActionResult<{ forgotten: string }>> {
  const ref = memoryRef.trim();
  if (ref === "" || ref.length > 200) {
    return {
      ok: false,
      reason: "invalid",
      field: "memoryRef",
      code: "invalid_input",
    };
  }
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentMemoryUpdate, {
    memoryId: ref,
    status: "RETRACTED",
  });
  return result.ok
    ? { ok: true, value: { forgotten: result.value.id } }
    : result;
}

/**
 * Approve the steering PR at its head (#4518, ADR-267). Under the team and
 * regulated modes the merge queue refuses a merge with `approval_required`
 * until a member other than the author approves. The approval is stored in
 * Oxagen, because GitHub refuses the Oxagen App's review of a pull request
 * it opened. The handler refuses the author (`author_cannot_approve`) and a
 * head that moved after the checks ran (`head_moved`). The answer is how
 * many people approved the head in Oxagen.
 */
export async function approveSteeringPr(
  org: string,
  ws: string,
  proposalId: string,
): Promise<ActionResult<{ approvals: number }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, steeringPrApprove, { proposalId });
  return result.ok
    ? { ok: true, value: { approvals: result.value.approvals } }
    : result;
}

/**
 * Merge a steering PR that holds no approval. The merge queue allows this to
 * an org or workspace owner, or to a member holding
 * `merge_pr_without_review`. It takes the same input as merge_steering_pr.
 */
export async function mergePrWithoutReview(
  org: string,
  ws: string,
  proposalId: string,
): Promise<ActionResult<{ commit: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, steeringPrMergeWithoutReview, {
    proposalId,
  });
  return result.ok
    ? { ok: true, value: { commit: result.value.mergedCommit } }
    : result;
}

/**
 * Drop one proposed steering record from a memory PR, named by its number
 * (#4518). The handler commits the file's removal to the memory PR's branch.
 * When the PR merges, its settlement rejects the record's statements and its
 * memories wait again. A record already dropped answers the commit that
 * dropped it.
 */
export async function dropMemoryRecord(
  org: string,
  ws: string,
  number: number,
  path: string,
): Promise<ActionResult<{ commitSha: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, steeringMemoryPrRecordDrop, {
    number,
    path,
  });
  return result.ok
    ? { ok: true, value: { commitSha: result.value.commit_sha } }
    : result;
}

/**
 * Restore the Oxagen managed block in one file of a steering PR, as a commit
 * on the pull request's branch (`restore_managed_block`). The six checks run
 * again on that commit. The answer is the commit. A file that holds no
 * managed block is refused as invalid before the kernel runs, and a block
 * that already matches the production branch as `block_intact`.
 */
export async function restoreManagedBlock(
  org: string,
  ws: string,
  proposalId: string,
  path: string,
): Promise<ActionResult<{ commitSha: string }>> {
  const ctx = await requireViewer(org, ws);
  // Only AGENTS.md, CLAUDE.md, and README.md hold a managed block. The
  // contract's own enum reads the path, and any other is refused here as the
  // seam refuses invalid input.
  const file = steeringPrRestoreManagedBlock.input.shape.path.safeParse(path);
  if (!file.success) {
    return { ok: false, reason: "invalid", code: "invalid_input", field: "path" };
  }
  const result = await kernelWrite(ctx, steeringPrRestoreManagedBlock, {
    proposalId,
    path: file.data,
  });
  return result.ok
    ? { ok: true, value: { commitSha: result.value.commit_sha } }
    : result;
}
