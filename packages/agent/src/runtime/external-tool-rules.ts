import {
  enforceExternalDecisionRules,
  type AuthorizeExternalCapabilityResult,
} from "@oxagen/oxagen/kernel";
import { DecisionRuleApprovalRequiredError } from "@oxagen/rules";
import { runInTenantScope } from "@oxagen/tenancy";
import type { CapabilityContext } from "../types";
import type { ApprovalRequiredEvent } from "./materialize-tools";
import { createApprovalRequest, waitForApproval } from "./approval";

/** One invocation owns its approval proof; it is never a standing external-tool grant. */
export function externalDecisionCheck(args: {
  name: string;
  input: unknown;
  ctx: CapabilityContext;
  runId?: string | null;
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
          const ttlMs = 5 * 60_000;
          const expiresAt = new Date(Date.now() + ttlMs).toISOString();
          const { approvalId } = await createApprovalRequest({
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
            capability: args.name,
            inputPreview: args.input,
            riskLevel: "high",
            expiresAt,
          });
          const resolution = await waitForApproval(approvalId);
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
