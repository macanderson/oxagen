"use server";
// The writes on the Work pages (agent-work-phase-1.html, Work lifecycle):
// enter an item, correct or retry triage, save and approve a brief, send it
// to one agent, withdraw or stop a send, return or accept the result, read
// the checks again, close and reopen an item, and set up a GitHub collector.
//
// Every action is a capability the kernel checks: the person's roles in this
// workspace (`workActionRoles` in @oxagen/work/records), a signed-in session
// (an API key or an agent run is refused), and the item version the page
// read, so a decision made on a stale read is refused with `conflict` and the
// page reads the item again. A work item grants no authority: the send reads
// its target, the operator, and the mandate on the server (ADR-251). Nothing
// here trusts what the page showed.
//
// A refusal comes back as the kernel seam classified it (`ActionResult`), and
// the dialog names the code in its own words (./action-failure.ts).
import { contextPrOpen } from "@oxagen/oxagen/contracts/context.pr.open";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import { workBriefApprove } from "@oxagen/oxagen/contracts/work.brief.approve";
import { workBriefSave } from "@oxagen/oxagen/contracts/work.brief.save";
import { workCollectorSet } from "@oxagen/oxagen/contracts/work.collector.set";
import { workCollectorSync } from "@oxagen/oxagen/contracts/work.collector.sync";
import { workItemClose } from "@oxagen/oxagen/contracts/work.item.close";
import { workItemCreate } from "@oxagen/oxagen/contracts/work.item.create";
import { workItemReopen } from "@oxagen/oxagen/contracts/work.item.reopen";
import { workOrderAccept } from "@oxagen/oxagen/contracts/work.order.accept";
import { workOrderCancel } from "@oxagen/oxagen/contracts/work.order.cancel";
import { workOrderChecksRefresh } from "@oxagen/oxagen/contracts/work.order.checks.refresh";
import { workOrderReturn } from "@oxagen/oxagen/contracts/work.order.return";
import { workOrderSend } from "@oxagen/oxagen/contracts/work.order.send";
import { workOrderStop } from "@oxagen/oxagen/contracts/work.order.stop";
import { workTriageRetry } from "@oxagen/oxagen/contracts/work.triage.retry";
import { workTriageRevise } from "@oxagen/oxagen/contracts/work.triage.revise";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** The item after a write: name its version on the next action. */
export type ItemAfter = { id: string; state: string; revision: number; version: number };

/** A criterion as the brief editor submits it. A new criterion has no key. */
export type CriterionDraft = {
  criterion: string | null;
  text: string;
  tag: "code" | "test" | "docs" | "review";
  intent: "check" | "review";
  evidence: string;
  provenance: "source" | "triage" | "person";
};

/** Enter a work item by title. Triage suggests its priority and drafts its brief. */
export async function createWorkItem(
  org: string,
  ws: string,
  input: { title: string; description: string; repository: string },
): Promise<ActionResult<{ id: string; number: string }>> {
  const ctx = await requireViewer(org, ws);
  const description = input.description.trim();
  const repository = input.repository.trim();
  const result = await kernelWrite(ctx, workItemCreate, {
    subject: input.title.trim(),
    ...(description === "" ? {} : { description }),
    labels: [],
    ...(repository === "" ? {} : { repository }),
  });
  if (!result.ok) return result;
  return { ok: true, value: { id: result.value.item_id, number: result.value.number } };
}

/**
 * Correct triage: a priority, labels, or the outcome, with the person's
 * reason. Each changed field is kept on the item, and a later triage run
 * never overwrites it. A null outcome clears a person's override.
 */
export async function reviseTriage(
  org: string,
  ws: string,
  input: {
    itemId: string;
    version: number;
    reason: string;
    priority?: "P0" | "P1" | "P2" | "P3";
    labels?: string[];
    outcome?: "triaged" | "needs_info" | "duplicate" | "out_of_scope" | null;
    duplicateOf?: string;
  },
): Promise<ActionResult<{ version: number }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workTriageRevise, {
    item_id: input.itemId,
    expected_version: input.version,
    reason: input.reason.trim(),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.labels === undefined ? {} : { labels: input.labels }),
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    ...(input.duplicateOf === undefined ? {} : { duplicate_of: input.duplicateOf }),
  });
  if (!result.ok) return result;
  return { ok: true, value: { version: result.value.version } };
}

/** Run triage again on an item whose triage failed. */
export async function retryTriage(
  org: string,
  ws: string,
  input: { itemId: string },
): Promise<ActionResult<{ queued: boolean }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workTriageRetry, { item_id: input.itemId });
  if (!result.ok) return result;
  return { ok: true, value: { queued: result.value.queued } };
}

function criteriaInput(criteria: readonly CriterionDraft[]) {
  return criteria.map((criterion) => ({
    ...(criterion.criterion === null ? {} : { id: criterion.criterion }),
    text: criterion.text.trim(),
    tag: criterion.tag,
    intent: criterion.intent,
    evidence: criterion.evidence.trim(),
    provenance: criterion.provenance,
  }));
}

/** Save a brief revision as a draft. Each criterion keeps its key. */
export async function saveBrief(
  org: string,
  ws: string,
  input: {
    itemId: string;
    version: number;
    itemRevision: number;
    repository: string;
    criteria: CriterionDraft[];
  },
): Promise<ActionResult<{ item: ItemAfter; brief: { revision: number; digest: string } }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workBriefSave, {
    item_id: input.itemId,
    version: input.version,
    item_revision: input.itemRevision,
    repository: input.repository.trim(),
    criteria: criteriaInput(input.criteria),
  });
  if (!result.ok) return result;
  return { ok: true, value: { item: result.value.item, brief: result.value.brief } };
}

/** Approve the latest saved brief revision for the item's current revision. */
export async function approveBrief(
  org: string,
  ws: string,
  input: {
    itemId: string;
    version: number;
    itemRevision: number;
    briefRevision: number;
    briefDigest: string;
  },
): Promise<ActionResult<{ item: ItemAfter }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workBriefApprove, {
    item_id: input.itemId,
    version: input.version,
    item_revision: input.itemRevision,
    brief_revision: input.briefRevision,
    brief_digest: input.briefDigest,
  });
  if (!result.ok) return result;
  return { ok: true, value: { item: result.value.item } };
}

/**
 * Save the brief for the item's current revision and approve it: the brief
 * triage drafted, or the approved brief again after the source changed. The
 * approval names the version the save returned, so a change by anyone else
 * between the two is refused as stale.
 */
export async function saveAndApproveBrief(
  org: string,
  ws: string,
  input: {
    itemId: string;
    version: number;
    itemRevision: number;
    repository: string;
    criteria: CriterionDraft[];
  },
): Promise<ActionResult<{ item: ItemAfter }>> {
  const ctx = await requireViewer(org, ws);
  const saved = await kernelWrite(ctx, workBriefSave, {
    item_id: input.itemId,
    version: input.version,
    item_revision: input.itemRevision,
    repository: input.repository.trim(),
    criteria: criteriaInput(input.criteria),
  });
  if (!saved.ok) return saved;
  const approved = await kernelWrite(ctx, workBriefApprove, {
    item_id: input.itemId,
    version: saved.value.item.version,
    item_revision: saved.value.item.revision,
    brief_revision: saved.value.brief.revision,
    brief_digest: saved.value.brief.digest,
  });
  if (!approved.ok) return approved;
  return { ok: true, value: { item: approved.value.item } };
}

/**
 * Send the approved brief to one agent. The key is fixed before the first
 * try (`<item>:r<brief revision>:s<send>`), so pressing Send again after a
 * lost answer returns the same work order and starts no second run.
 */
export async function sendWork(
  org: string,
  ws: string,
  input: {
    itemId: string;
    version: number;
    itemRevision: number;
    briefRevision: number;
    briefDigest: string;
    agentId: string;
    key: string;
  },
): Promise<ActionResult<{ item: ItemAfter; orderId: string; repeat: boolean }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workOrderSend, {
    item_id: input.itemId,
    version: input.version,
    item_revision: input.itemRevision,
    brief_revision: input.briefRevision,
    brief_digest: input.briefDigest,
    agent_id: input.agentId,
    key: input.key,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    value: { item: result.value.item, orderId: result.value.order.id, repeat: result.value.repeat },
  };
}

/** Withdraw a send no runtime claimed. It ends at once. */
export async function cancelSend(
  org: string,
  ws: string,
  input: { itemId: string; version: number; orderId: string; reason: string },
): Promise<ActionResult<{ item: ItemAfter }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workOrderCancel, {
    item_id: input.itemId,
    version: input.version,
    work_order_id: input.orderId,
    reason: input.reason.trim(),
  });
  if (!result.ok) return result;
  return { ok: true, value: { item: result.value.item } };
}

/** Ask the runtime to stop a claimed run. The send reads stopping until the runtime confirms. */
export async function stopSend(
  org: string,
  ws: string,
  input: { itemId: string; version: number; orderId: string; reason: string },
): Promise<ActionResult<{ item: ItemAfter }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workOrderStop, {
    item_id: input.itemId,
    version: input.version,
    work_order_id: input.orderId,
    reason: input.reason.trim(),
  });
  if (!result.ok) return result;
  return { ok: true, value: { item: result.value.item } };
}

/**
 * Return the work with a reason. By default it goes out again to the same
 * agent as a new send. When that send is refused, the return stands and the
 * item waits in Ready, and `resendRefused` says why.
 */
export async function returnWork(
  org: string,
  ws: string,
  input: { itemId: string; version: number; orderId: string; reason: string; resend: boolean },
): Promise<ActionResult<{ item: ItemAfter; resent: boolean; resendRefused: string | null }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workOrderReturn, {
    item_id: input.itemId,
    version: input.version,
    work_order_id: input.orderId,
    reason: input.reason.trim(),
    resend: input.resend,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      item: result.value.item,
      resent: result.value.resent !== null,
      resendRefused: result.value.resend_refused,
    },
  };
}

/**
 * Accept a send's result on the pull request's head commit, with every
 * criterion ticked. Oxagen reads the required checks again at the press, and
 * a required check that is not passing refuses it. Acceptance merges
 * nothing.
 */
export async function acceptWork(
  org: string,
  ws: string,
  input: {
    itemId: string;
    version: number;
    orderId: string;
    headSha: string;
    briefDigest: string;
    criteria: string[];
  },
): Promise<ActionResult<{ item: ItemAfter; requiredChecks: string[] }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workOrderAccept, {
    item_id: input.itemId,
    version: input.version,
    work_order_id: input.orderId,
    head_sha: input.headSha,
    brief_digest: input.briefDigest,
    criteria: input.criteria,
  });
  if (!result.ok) return result;
  return { ok: true, value: { item: result.value.item, requiredChecks: result.value.required_checks } };
}

/** Read the pull request's checks from GitHub again and record what it reports. */
export async function refreshChecks(
  org: string,
  ws: string,
  input: { itemId: string; orderId: string },
): Promise<ActionResult<{ requiredChecks: string[] | null; unreadReason: string | null }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workOrderChecksRefresh, {
    item_id: input.itemId,
    work_order_id: input.orderId,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    value: { requiredChecks: result.value.required_checks, unreadReason: result.value.unread_reason },
  };
}

/** Close an item without finishing it, with a resolution and a reason. Nothing is written back to GitHub. */
export async function closeItem(
  org: string,
  ws: string,
  input: { itemId: string; version: number; resolution: "cancelled" | "declined" | "duplicate"; reason: string },
): Promise<ActionResult<{ item: ItemAfter }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workItemClose, {
    item_id: input.itemId,
    version: input.version,
    resolution: input.resolution,
    reason: input.reason.trim(),
  });
  if (!result.ok) return result;
  return { ok: true, value: { item: result.value.item } };
}

/** Reopen a closed or done item. Its history stays, and the brief goes back to a draft. */
export async function reopenItem(
  org: string,
  ws: string,
  input: { itemId: string; version: number; reason: string },
): Promise<ActionResult<{ item: ItemAfter }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workItemReopen, {
    item_id: input.itemId,
    version: input.version,
    reason: input.reason.trim(),
  });
  if (!result.ok) return result;
  return { ok: true, value: { item: result.value.item } };
}

/**
 * Add or change a GitHub collector: its name and the repositories it reads,
 * each linked to the workspace. It reads through the GitHub connection they
 * were linked through, so none is named here. A new or widened collector
 * reads those repositories once now. Pass paused to pause or resume it.
 */
export async function setCollector(
  org: string,
  ws: string,
  input: { name: string; repos?: string[]; paused?: boolean },
): Promise<ActionResult<{ created: boolean; reconcileQueued: boolean }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workCollectorSet, {
    name: input.name.trim(),
    ...(input.repos === undefined
      ? {}
      : { repos: input.repos.map((repo) => repo.trim()).filter((repo) => repo !== "") }),
    ...(input.paused === undefined ? {} : { paused: input.paused }),
  });
  if (!result.ok) return result;
  return { ok: true, value: { created: result.value.created, reconcileQueued: result.value.reconcile_queued } };
}

/** Read a collector's repositories again now. The collector is named by its name. */
export async function syncCollector(
  org: string,
  ws: string,
  input: { name: string },
): Promise<ActionResult<{ queued: boolean }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, workCollectorSync, { name: input.name });
  if (!result.ok) return result;
  return { ok: true, value: { queued: result.value.queued } };
}

/** The lineage triage reads priorities from (get_work_priorities matches it, or one ending in it). */
const PRIORITIES_LINEAGE = "work.priorities";

/**
 * Propose the workspace's priorities record (propose_record): a steering
 * rule whose statement is the instruction line and the numbered rules, with
 * their line breaks kept, because triage reads one rule per numbered line.
 * Its force is info, so it reaches the requests it fits rather than every
 * agent request. A proposal steers nothing: triage reads the record once the
 * pull request openPrioritiesPr opens has merged.
 */
export async function proposePriorities(
  org: string,
  ws: string,
  input: { statement: string },
): Promise<ActionResult<{ proposalId: string; lineageId: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, contextProposalCreate, {
    record: {
      lineageId: PRIORITIES_LINEAGE,
      label: "Work priorities",
      kind: "rule",
      force: "info",
      sharingScope: "workspace",
      statement: input.statement.trim(),
    },
    rationale: "Triage ranks each new work item by these rules and cites the rule it used.",
    support: {},
    createOnly: true,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    value: { proposalId: result.value.proposalId, lineageId: result.value.lineageId },
  };
}

/**
 * Open the steering pull request for a proposed priorities record
 * (open_context_pr). It answers with the pull request, or null when the
 * workspace's steering repository could not take one.
 */
export async function openPrioritiesPr(
  org: string,
  ws: string,
  input: { proposalId: string },
): Promise<ActionResult<{ proposalId: string; pr: { number: number; url: string; repository: string } | null }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, contextPrOpen, { proposalId: input.proposalId });
  if (!result.ok) return result;
  const pr = result.value.pr;
  return {
    ok: true,
    value: {
      proposalId: result.value.proposalId,
      pr: pr === null ? null : { number: pr.number, url: pr.url, repository: pr.repository },
    },
  };
}
