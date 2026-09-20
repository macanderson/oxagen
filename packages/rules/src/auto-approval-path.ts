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
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { loadRuleSetIn, lockDecisionRulesIn } from "./rule-store";
import { policyApprover } from "@oxagen/oxagen/approval-rules/schemas";
import { and, eq } from "drizzle-orm";
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
  ctx: {
    orgId: string;
    workspaceId: string;
    userId: string | null;
    /**
     * The internal id (`agent_runs.id`) of the run this call belongs to;
     * null when none is in scope. Resolved to its public id and written as
     * `run_public_id` on the receipt, so the Run page's Resolved section
     * (`list_resolved_approvals`, #3153) can find a call a rule released
     * with no person the same way it finds one a person answered.
     */
    runId?: string | null;
  };
  /** Test seam. */
  now?: () => Date;
}

/**
 * The run's public id (`arun_…`), for the receipt's `run_public_id` column.
 * Null when no run was in scope, or when the given id does not resolve to a
 * run in this org and workspace: a fabricated or stale id must never be
 * written as if it named a real run.
 */
async function resolveRunPublicId(
  tx: Parameters<Parameters<typeof withTenantDb>[0]>[0],
  args: { orgId: string; workspaceId: string; runId: string | null },
): Promise<string | null> {
  if (!args.runId) return null;
  const [row] = await tx
    .select({ publicId: schema.agentRuns.publicId })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.id, args.runId),
        eq(schema.agentRuns.orgId, args.orgId),
        eq(schema.agentRuns.workspaceId, args.workspaceId),
      ),
    )
    .limit(1);
  return row?.publicId ?? null;
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
  const at = (args.now ?? (() => new Date()))();
  const digest = inputDigest(args.input);

  const evaluateIn = async (tx: Tx) => {
    await lockDecisionRulesIn(tx, args.ctx.workspaceId);
    const rules =
      (await loadRuleSetIn(tx, args.ctx.workspaceId))?.autoApproval ?? [];
    const subject = await buildAutoApprovalSubject(tx, {
      capability: args.capability,
      input: args.input,
      workspaceId: args.ctx.workspaceId,
      digest,
      rules,
      now: (args.now ?? (() => new Date()))(),
    });
    return {
      outcome: evaluateAutoApproval(rules, subject),
      riskLevel: subject.tool?.riskGrade ?? "low",
    };
  };
  const evaluated = await withTenantDb(evaluateIn);
  const outcome = evaluated.outcome;
  if (outcome === null) return null;
  if (!outcome.ok) return outcome;

  return {
    ...outcome,
    commit: async () => {
      // `.returning()` is not read back for its own read path. That is
      // `list_resolved_approvals` (#3153, ADR-109), which queries the row
      // fresh rather than trusting a value threaded through the call stack.
      // It is logged here so the id this insert used to discard is visible
      // on the write path too, the instant the receipt is written.
      const [row] = await withTenantDb(async (tx) => {
        const current = await evaluateIn(tx);
        if (!current.outcome?.ok || current.outcome.ruleId !== outcome.ruleId) {
          throw new HandlerError({
            code: "conflict",
            reason: "approval_policy_changed",
            message:
              "The approval rule changed before the call was released. Retry the call.",
          });
        }
        const runPublicId = await resolveRunPublicId(tx, {
          orgId: args.ctx.orgId,
          workspaceId: args.ctx.workspaceId,
          runId: args.ctx.runId ?? null,
        });
        return tx
          .insert(schema.approvalRequests)
          .values({
            orgId: args.ctx.orgId,
            workspaceId: args.ctx.workspaceId,
            capabilityName: args.capability,
            inputPreview: (args.input ?? {}) as object,
            // The declared tool's grade: `ok` is unreachable without one,
            // because a capability with no declared tool is a floor.
            riskLevel: current.riskLevel,
            ruleIds: [args.verdict.ruleId],
            inputDigest: digest,
            autoRuleId: outcome.ruleId,
            resolvedReasons: [],
            resolution: "approved",
            resolvedAt: at,
            resolvedByPolicy: policyApprover(outcome.ruleId),
            // The run this call belongs to (#3153): null when none was in
            // scope, never a fabricated stand-in.
            runPublicId,
            // The token is minted and spent by the call this decision releases;
            // an approval nobody has to act on never waits.
            tokenUsedAt: at,
            expiresAt: at,
            createdById: args.ctx.userId ?? undefined,
          })
          .returning({ publicId: schema.approvalRequests.publicId });
      });
      emitAutoApproved(args);
      logger.info(
        {
          capability: args.capability,
          rule: args.verdict.ruleId,
          autoRule: outcome.ruleId,
          approvalId: row?.publicId,
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
