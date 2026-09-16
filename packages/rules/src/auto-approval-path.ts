/**
 * What happens when a decision rule sends a call to a person and an
 * auto-approval rule says it does not have to go (MC spec §6.9 part 2,
 * ADR-070).
 *
 * The gate asks this module at exactly one point: a `require_approval`
 * verdict, before it throws. The ask is READ-ONLY. It evaluates the clause
 * and, when a rule's conditions hold, hands back a `commit` that writes the
 * approval row already resolved, with `resolved_by_policy = policy:<rule id>`
 * and its single-use token spent. The gate calls it at the very end, once the
 * mandate check has cleared as well, because a mandate's own approval rule
 * runs after the rules and can still park the call — and a receipt saying no
 * person looked, for a call a person was required to look at, inverts the one
 * thing the `policy:` form exists for. When the conditions do not hold,
 * nothing is written and the gate throws exactly as it did before.
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

/** What the evaluator said, and what writing the answer down will take. */
export type AutoApprovalDecision = AutoApprovalOutcome & {
  /**
   * Present only when `ok`; writes the approval row and emits the event.
   *
   * Runs in the CALLER'S tenant scope — it reaches Postgres through
   * `withTenantDb` and captures no scope of its own. The gate calls it from
   * inside the one `runInTenantScope` the kernel wraps the decision gate and
   * the handler in, so production is always in scope; a caller that defers it
   * out of that context gets `TenantScopeError`.
   */
  commit?: () => Promise<void>;
};

/**
 * Evaluate the workspace's auto-approval clause against one parked call.
 *
 * Writes nothing. Returns the evaluation, or null when no rule covers the
 * call; `commit` is the caller's to run once every later check has cleared.
 */
export async function autoApproveParkedCall(
  args: AutoApproveArgs,
): Promise<AutoApprovalDecision | null> {
  const rules = args.ruleSet.autoApproval ?? [];
  if (rules.length === 0) return null;
  const at = (args.now ?? (() => new Date()))();
  const digest = inputDigest(args.input);

  const evaluated = await withTenantDb(async (tx) => {
    const subject = await buildAutoApprovalSubject(tx, {
      capability: args.capability,
      input: args.input,
      workspaceId: args.ctx.workspaceId,
      digest,
      now: at,
    });
    return {
      outcome: evaluateAutoApproval(rules, subject),
      riskLevel: subject.tool?.riskGrade ?? "low",
    };
  });
  const outcome = evaluated.outcome;
  if (outcome === null) return null;
  if (!outcome.ok) return outcome;

  return {
    ...outcome,
    commit: async () => {
      await withTenantDb((tx) =>
        tx.insert(schema.approvalRequests).values({
          orgId: args.ctx.orgId,
          workspaceId: args.ctx.workspaceId,
          capabilityName: args.capability,
          inputPreview: (args.input ?? {}) as object,
          // The declared tool's grade: `ok` is unreachable without one,
          // because a capability with no declared tool is a floor.
          riskLevel: evaluated.riskLevel,
          ruleIds: [args.verdict.ruleId],
          inputDigest: digest,
          autoRuleId: outcome.ruleId,
          resolvedReasons: [],
          resolution: "approved",
          resolvedAt: at,
          resolvedByPolicy: policyApprover(outcome.ruleId),
          // The token is minted and spent by the call this decision releases;
          // an approval nobody has to act on never waits.
          tokenUsedAt: at,
          expiresAt: at,
          createdByUserId: args.ctx.userId ?? undefined,
        }),
      );
      emitAutoApproved(args);
      logger.info(
        {
          capability: args.capability,
          rule: args.verdict.ruleId,
          autoRule: outcome.ruleId,
        },
        "auto-approval: the call proceeded with no person",
      );
    },
  };
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
