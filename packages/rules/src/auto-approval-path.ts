/**
 * What happens when a decision rule sends a call to a person and an
 * auto-approval rule says it does not have to go (MC spec §6.9 part 2,
 * ADR-069).
 *
 * The gate asks this module at exactly one point: a `require_approval`
 * verdict, before it throws. When a rule's conditions hold, an approval row
 * is written already resolved, with `resolved_by_policy = policy:<rule id>`
 * and its single-use token spent by the call that is about to proceed, and
 * the gate lets the call through. When they do not hold, nothing is written
 * and the gate throws exactly as it did before: the call goes to a person.
 *
 * The row is the receipt's evidence that no person looked. `resolved_by_user_id`
 * stays null, and the two columns cannot both be set (the migration's CHECK),
 * so an auditor can never read a policy decision as somebody's.
 *
 * A mandate's own approval rule is not answerable here. It parks the call
 * before the handler ever runs and outranks any workspace rule (§6.9 part 3),
 * so the evaluation on that path is recorded beside the parked row and the
 * row still waits for a person — `decideMandate` does that, and this module
 * never sees it.
 */
import { schema, withTenantDb } from "@oxagen/database";
import { policyApprover } from "@oxagen/oxagen/approval-rules/schemas";
import {
  evaluateAutoApproval,
  type AutoApprovalOutcome,
} from "./auto-approval";
import { buildAutoApprovalSubject, inputDigest } from "./call-facts";
import { logger } from "./logger";
import type { RuleSet, Verdict } from "./types";

export interface AutoApproveArgs {
  capability: string;
  input: unknown;
  ruleSet: RuleSet;
  /** The gate rule that asked for a person; recorded on the row as the rule that fired. */
  verdict: Verdict;
  ctx: { orgId: string; workspaceId: string; userId: string | null };
  /** Test seam. */
  now?: () => Date;
}

/**
 * Evaluate the workspace's auto-approval clause against one parked call, and
 * record the approval when it qualifies.
 *
 * Returns the evaluation, or null when no rule covers the call. Only an
 * outcome with `ok` has written anything.
 */
export async function autoApproveParkedCall(
  args: AutoApproveArgs,
): Promise<AutoApprovalOutcome | null> {
  const rules = args.ruleSet.autoApproval ?? [];
  if (rules.length === 0) return null;
  const at = (args.now ?? (() => new Date()))();
  const digest = inputDigest(args.input);

  const outcome = await withTenantDb(async (tx) => {
    const subject = await buildAutoApprovalSubject(tx, {
      capability: args.capability,
      input: args.input,
      workspaceId: args.ctx.workspaceId,
      digest,
      now: at,
    });
    const evaluated = evaluateAutoApproval(rules, subject);
    if (evaluated === null || !evaluated.ok) return evaluated;

    await tx.insert(schema.approvalRequests).values({
      orgId: args.ctx.orgId,
      workspaceId: args.ctx.workspaceId,
      capabilityName: args.capability,
      inputPreview: (args.input ?? {}) as object,
      // The declared tool's grade: `ok` is unreachable without one, because a
      // capability with no declared tool is a floor.
      riskLevel: subject.tool?.riskGrade ?? "low",
      ruleIds: [args.verdict.ruleId],
      inputDigest: digest,
      autoRuleId: evaluated.ruleId,
      resolvedReasons: [],
      resolution: "approved",
      resolvedAt: at,
      resolvedByPolicy: policyApprover(evaluated.ruleId),
      // The token is minted and spent by the call this decision releases; an
      // approval nobody has to act on never waits.
      tokenUsedAt: at,
      expiresAt: at,
      createdByUserId: args.ctx.userId ?? undefined,
    });
    return evaluated;
  });

  if (outcome?.ok) {
    emitAutoApproved(args);
    logger.info(
      {
        capability: args.capability,
        rule: args.verdict.ruleId,
        autoRule: outcome.ruleId,
      },
      "auto-approval: the call proceeded with no person",
    );
  }
  return outcome;
}

/**
 * The audit row for a decision no person made. Loaded on the decision path,
 * not at module load: `@oxagen/database/security` pulls the telemetry barrel,
 * the Postgres client and the full schema, and this module sits on the import
 * graph of every rules consumer.
 */
function emitAutoApproved(args: AutoApproveArgs): void {
  void import("@oxagen/database/security")
    .then(({ emitSecurityEventAsync }) =>
      emitSecurityEventAsync({
        eventType: "approval.auto_approved",
        actorUserId: args.ctx.userId,
        orgId: args.ctx.orgId,
        workspaceId: args.ctx.workspaceId,
        capability: args.capability,
        outcome: "allow",
        ip: null,
        userAgent: null,
        requestId: null,
      }),
    )
    .catch((err: unknown) =>
      logger.error({ err }, "auto-approval: security event emission failed"),
    );
}
