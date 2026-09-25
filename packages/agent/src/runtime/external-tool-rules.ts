import {
  enforceExternalDecisionRules,
  type AuthorizeExternalCapabilityResult,
} from "@oxagen/oxagen/kernel";
import {
  DecisionRuleApprovalRequiredError,
  DecisionRuleDeniedError,
} from "@oxagen/rules";
import { runInTenantScope } from "@oxagen/tenancy";
import type { CapabilityContext } from "../types";
import type { ApprovalRequiredEvent } from "./materialize-tools";
import { createApprovalRequest, waitForApproval } from "./approval";
import { externalApproval } from "./external-approval";

/**
 * A person answered the rule's approval request with no.
 *
 * Distinct from the approval-required error the rule raised, which a surface
 * reads as "open the approval flow". Re-raising that after a refusal sent the
 * caller back to the flow the person had just closed. A refusal is a denial
 * in the same shape a `deny` rule produces, so every surface that already
 * shows a denied call shows this one the same way, naming the rule.
 */
function refusedByPerson(
  required: DecisionRuleApprovalRequiredError,
): DecisionRuleDeniedError {
  return new DecisionRuleDeniedError({
    effect: "deny",
    ruleId: required.verdict.ruleId,
    description: `a person refused the approval this rule requires. ${required.verdict.description}`,
  });
}

/** One invocation owns its approval proof; it is never a standing external-tool grant. */
export function externalDecisionCheck(args: {
  name: string;
  input: unknown;
  ctx: CapabilityContext;
  runId?: string | null;
  approvalMode?: "park" | "wait";
  principal?: AuthorizeExternalCapabilityResult["principal"];
  onApprovalRequired?: (event: ApprovalRequiredEvent) => void;
}) {
  const toolCallId = crypto.randomUUID();
  let approvedDigest: string | undefined;
  let approvedUntil = 0;
  return (
    options: {
      principal?: AuthorizeExternalCapabilityResult["principal"];
      interactive?: boolean;
    } = {},
  ) =>
    runInTenantScope(
      { orgId: args.ctx.orgId, workspaceId: args.ctx.workspaceId },
      async () => {
        if (Date.now() >= approvedUntil) approvedDigest = undefined;
        const check = () =>
          enforceExternalDecisionRules(args.name, args.input, args.ctx, {
            approvedDigest,
            runId: args.runId,
            principal: options.principal ?? args.principal,
          });
        try {
          await check();
          return;
        } catch (error) {
          if (
            !(error instanceof DecisionRuleApprovalRequiredError) ||
            !error.approvalDigest
          )
            throw error;
          if (
            options.interactive === false ||
            !args.ctx.messageId ||
            !args.onApprovalRequired
          )
            throw error;
          if (args.approvalMode === "park") {
            if (!args.ctx.userId) throw error;
            const approval = await externalApproval({
              orgId: args.ctx.orgId,
              workspaceId: args.ctx.workspaceId,
              userId: args.ctx.userId,
              messageId: args.ctx.messageId,
              capabilityName: args.name,
              input: args.input,
              approvalDigest: error.approvalDigest,
              runId: args.runId,
            });
            if (approval.status === "approved") {
              if (Date.now() >= approval.expiresAt.getTime()) throw error;
              approvedDigest = error.approvalDigest;
              approvedUntil = approval.expiresAt.getTime();
              await check();
              return;
            }
            if (approval.status === "refused") throw refusedByPerson(error);
            args.onApprovalRequired({
              approvalId: approval.approvalId,
              // Carried to the parked call's ledger receipt, which names the
              // approval the way the Run page shows it.
              approvalPublicId: approval.approvalPublicId,
              capability: args.name,
              inputPreview: args.input,
              riskLevel: "high",
              expiresAt: approval.expiresAt.toISOString(),
            });
            throw error;
          }
          const ttlMs = 5 * 60_000;
          const expiresAt = new Date(Date.now() + ttlMs).toISOString();
          const { approvalId, approvalPublicId } = await createApprovalRequest({
            orgId: args.ctx.orgId,
            workspaceId: args.ctx.workspaceId,
            messageId: args.ctx.messageId,
            toolCallId,
            capabilityName: args.name,
            inputPreview: args.input,
            digestInput: args.input,
            riskLevel: "high",
            ttlMs,
            runId: args.runId,
          });
          args.onApprovalRequired({
            approvalId,
            // The surface's card names the approval by its public id, as the
            // parked path above and a governed write's approval both do.
            approvalPublicId,
            capability: args.name,
            inputPreview: args.input,
            riskLevel: "high",
            expiresAt,
          });
          const resolution = await waitForApproval(approvalId);
          if (resolution.resolution === "denied") throw refusedByPerson(error);
          if (
            resolution.resolution !== "approved" ||
            Date.now() >= Date.parse(expiresAt)
          )
            throw error;
          approvedDigest = error.approvalDigest;
          approvedUntil = Date.parse(expiresAt);
        }
        // Re-read current rules after the wait. A changed rule needs a new decision.
        await check();
      },
    );
}
