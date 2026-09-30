"use server";
// The Context PR writes (#2961; ADR-061), each through the kernel seam for the
// workspace viewer the URL names. Every contract is `noBillingGate`.
// open_context_pr and dismiss_proposal gate the acting user's role in their
// handlers (INV-29); merge_context_pr gates the signed-in reviewer the
// governance mode names. A refusal comes back as `denied` or `conflict` with
// the handler's reason as its code, and nothing changed.
import { agentMemoryUpdate } from "@oxagen/oxagen/contracts/agent.memory.update";
import { contextGovernanceModeSet } from "@oxagen/oxagen/contracts/context.governance_mode.set";
import { contextPrMerge } from "@oxagen/oxagen/contracts/context.pr.merge";
import { contextPrMergeWithoutReview } from "@oxagen/oxagen/contracts/context.pr.merge_without_review";
import { contextPrOpen } from "@oxagen/oxagen/contracts/context.pr.open";
import { contextProposalDismiss } from "@oxagen/oxagen/contracts/context.proposal.dismiss";
import { governanceModeSchema } from "@oxagen/oxagen/contracts/context.steering.shared";
import { workspaceSettingsWrite } from "@oxagen/oxagen/contracts/workspace.settings.write";
import { z } from "zod";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** Opens the proposal's Context PR and runs its six checks, or re-runs them on the pull request already open; returns where the machine stopped. */
export async function openContextPr(
  org: string,
  ws: string,
  proposalId: string,
): Promise<
  ActionResult<{ status: ContractOutput<typeof contextPrOpen>["status"] }>
> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, contextPrOpen, { proposalId });
  return result.ok
    ? { ok: true, value: { status: result.value.status } }
    : result;
}

/** Merges the pull request once every check passed; merge publishes the record. */
export async function mergeContextPr(
  org: string,
  ws: string,
  proposalId: string,
): Promise<ActionResult<{ commit: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, contextPrMerge, { proposalId });
  return result.ok
    ? { ok: true, value: { commit: result.value.mergedCommit } }
    : result;
}

/** Dismisses the proposal with a reason; an open pull request for it is closed and its branch deleted. */
export async function dismissProposal(
  org: string,
  ws: string,
  proposalId: string,
  reason: string,
): Promise<ActionResult<{ status: "rejected" }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, contextProposalDismiss, {
    proposalId,
    reason: reason.trim(),
  });
  return result.ok
    ? { ok: true, value: { status: result.value.status } }
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
  pullRequest: { number: number; htmlUrl: string } | null;
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
  const { outcome, requestedMode, fullName, productionBranch, pullRequest } =
    result.value;
  return {
    ok: true,
    value: {
      outcome,
      mode: requestedMode,
      repository: fullName,
      branch: productionBranch,
      pullRequest:
        pullRequest === null
          ? null
          : { number: pullRequest.number, htmlUrl: pullRequest.htmlUrl },
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

// The steering PR writes the platform has not registered yet (#4518):
// approve_context_pr, drop_memory_record and restore_managed_block. Each one
// is a local contract under the name the platform will register, so the
// kernel answers `unavailable` with code `tool_not_registered` today, and the
// same call reaches the handler, unchanged, once the capability lands. The
// schemas are the proposed shapes. The platform contract replaces each one,
// as merge_pr_without_review's did (#4528).
const PROPOSAL_ID = z.string().regex(/^prp_[0-9A-Za-z]+$/);

const approveContextPrContract = {
  name: "approve_context_pr",
  input: z.object({ proposalId: PROPOSAL_ID }).strict(),
  output: z.object({ approvals: z.number().int().nonnegative() }),
};

const dropMemoryRecordContract = {
  name: "drop_memory_record",
  input: z
    .object({
      branch: z.string().startsWith("memory/"),
      path: z.string().min(1),
    })
    .strict(),
  output: z.object({ commit_sha: z.string(), rejection_id: z.string() }),
};

const restoreManagedBlockContract = {
  name: "restore_managed_block",
  input: z
    .object({ proposalId: PROPOSAL_ID, path: z.string().min(1) })
    .strict(),
  output: z.object({ commit_sha: z.string() }),
};

/**
 * Approve the steering PR. Under the team and regulated modes the merge
 * queue refuses a merge with `approval_required` until a member other than
 * the author approves. The answer is the approval count after this one.
 */
export async function approveContextPr(
  org: string,
  ws: string,
  proposalId: string,
): Promise<ActionResult<{ approvals: number }>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, approveContextPrContract, { proposalId });
}

/**
 * Merge a steering PR that holds no approval. The merge queue allows this to
 * an org or workspace owner, or to a member holding
 * `merge_pr_without_review`. It takes the same input as merge_context_pr.
 */
export async function mergePrWithoutReview(
  org: string,
  ws: string,
  proposalId: string,
): Promise<ActionResult<{ commit: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, contextPrMergeWithoutReview, {
    proposalId,
  });
  return result.ok
    ? { ok: true, value: { commit: result.value.mergedCommit } }
    : result;
}

/**
 * Drop one proposed steering record from a memory PR. The handler commits
 * the file's removal to the memory branch and records the rejection.
 */
export async function dropMemoryRecord(
  org: string,
  ws: string,
  branch: string,
  path: string,
): Promise<ActionResult<{ commitSha: string; rejectionId: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, dropMemoryRecordContract, {
    branch,
    path,
  });
  return result.ok
    ? {
        ok: true,
        value: {
          commitSha: result.value.commit_sha,
          rejectionId: result.value.rejection_id,
        },
      }
    : result;
}

/**
 * Restore the Oxagen managed block in one file of a steering PR, as a commit
 * on the pull request's branch. The answer is that commit.
 */
export async function restoreManagedBlock(
  org: string,
  ws: string,
  proposalId: string,
  path: string,
): Promise<ActionResult<{ commitSha: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, restoreManagedBlockContract, {
    proposalId,
    path,
  });
  return result.ok
    ? { ok: true, value: { commitSha: result.value.commit_sha } }
    : result;
}
