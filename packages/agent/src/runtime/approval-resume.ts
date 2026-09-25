import { schema, withTenantDb, withSystemDb } from "@oxagen/database";
import { bootstrapIAMRuntime } from "@oxagen/iam";
import {
  resolveActorOrgRoles,
  resolveActorWorkspaceRoles,
} from "@oxagen/iam/org-role";
import {
  bootstrapBillingRuntime,
  getSpendBudgetStatuses,
} from "@oxagen/billing";
import { bootstrapEntitlementRuntime } from "@oxagen/plugins";
import {
  bootstrapDecisionRulesRuntime,
  inputDigest,
  DecisionRuleDeniedError,
  DecisionRuleApprovalRequiredError,
  DecisionRuleUnavailableError,
} from "@oxagen/rules";
import {
  getCapability,
  invoke,
  CapabilityError,
  type CapabilityContext,
} from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  notInArray,
} from "drizzle-orm";
import {
  ApprovalResumeError,
  decryptApprovalResume,
} from "./approval-resume-payload";
import { materializeTools } from "./materialize-tools";
import { createKillSwitchGate } from "./kill-switch-gate";
import { openAssistantRun, type AssistantRunRecorder } from "./assistant-run";

const a = schema.approvalRequests;
export interface ApprovalResumeRef {
  id: string;
  orgId: string;
  workspaceId: string;
}

async function dedicatedResumeOrganizations(): Promise<string[]> {
  const rows = await withSystemDb((tx) =>
    tx
      .select({ orgId: schema.dataPlanes.orgId })
      .from(schema.dataPlanes)
      .where(
        and(
          eq(schema.dataPlanes.kind, "postgres"),
          eq(schema.dataPlanes.mode, "dedicated"),
          isNull(schema.dataPlanes.deletedAt),
        ),
      ),
  );
  return rows.map((row) => row.orgId);
}

/** Workspace references live on the control plane, including dedicated tenants. */
export async function listDedicatedApprovalResumeScopes() {
  const orgIds = await dedicatedResumeOrganizations();
  if (orgIds.length === 0) return [];
  return withSystemDb((tx) =>
    tx
      .select({
        orgId: schema.workspaces.orgId,
        workspaceId: schema.workspaces.id,
      })
      .from(schema.workspaces)
      .where(inArray(schema.workspaces.orgId, orgIds)),
  );
}

/** Scan one data plane without exporting stored arguments to the scheduler. */
export async function listApprovalResumes(scope?: {
  orgId: string;
  workspaceId: string;
}) {
  const dedicatedOrgIds = scope ? [] : await dedicatedResumeOrganizations();
  const select = (tx: Parameters<Parameters<typeof withTenantDb>[0]>[0]) =>
    tx
      .select({ id: a.id, orgId: a.orgId, workspaceId: a.workspaceId })
      .from(a)
      .where(
        and(
          isNotNull(a.resumePayload),
          scope
            ? and(
                eq(a.orgId, scope.orgId),
                eq(a.workspaceId, scope.workspaceId),
              )
            : dedicatedOrgIds.length
              ? notInArray(a.orgId, dedicatedOrgIds)
              : undefined,
          or(
            eq(a.resumeStatus, "queued"),
            and(eq(a.resumeStatus, "waiting"), lt(a.expiresAt, new Date())),
            and(
              eq(a.resumeStatus, "running"),
              lt(a.resumeStartedAt, new Date(Date.now() - 15 * 60_000)),
            ),
          ),
        ),
      )
      .orderBy(a.createdAt)
      .limit(100);
  return scope
    ? runInTenantScope(scope, () => withTenantDb(select))
    : withSystemDb(select);
}

/** One durable claim precedes all work. Running attempts are never reclaimed. */
export async function resumeApprovedCall(
  ref: ApprovalResumeRef,
): Promise<string> {
  return runInTenantScope(
    { orgId: ref.orgId, workspaceId: ref.workspaceId },
    async () => {
      const bounds = and(
        eq(a.id, ref.id),
        eq(a.orgId, ref.orgId),
        eq(a.workspaceId, ref.workspaceId),
      );
      const now = new Date();
      await withTenantDb(async (tx) => {
        await tx
          .update(a)
          .set({
            resumeStatus: "indeterminate",
            resumeError: "attempt_interrupted",
            resumeFinishedAt: now,
          })
          .where(
            and(
              bounds,
              eq(a.resumeStatus, "running"),
              lt(a.resumeStartedAt, new Date(now.getTime() - 15 * 60_000)),
            ),
          );
        await tx
          .update(a)
          .set({ resolution: "expired", resolvedAt: now })
          .where(
            and(
              bounds,
              eq(a.resumeStatus, "waiting"),
              isNull(a.resolution),
              lt(a.expiresAt, now),
            ),
          );
        await tx
          .update(a)
          .set({
            resumeStatus: "expired",
            resumeError: "approval_expired",
            resumeFinishedAt: now,
          })
          .where(
            and(
              bounds,
              inArray(a.resumeStatus, ["waiting", "queued"]),
              lt(a.expiresAt, now),
            ),
          );
      });
      const [row] = await withTenantDb((tx) =>
        tx
          .update(a)
          .set({ resumeStatus: "running", resumeStartedAt: now })
          .where(
            and(
              bounds,
              eq(a.resolution, "approved"),
              eq(a.resumeStatus, "queued"),
              gt(a.expiresAt, now),
              isNotNull(a.resumePayload),
            ),
          )
          .returning(),
      );
      if (!row) return "not_claimed";

      const finish = (status: string, reason: string | null) =>
        withTenantDb((tx) =>
          tx
            .update(a)
            .set({
              resumeStatus: status,
              resumeError: reason,
              resumeFinishedAt: new Date(),
            })
            .where(
              and(
                bounds,
                inArray(a.resumeStatus, ["running", "indeterminate"]),
              ),
            ),
        );
      let run: AssistantRunRecorder | undefined;
      let dispatched = false;
      try {
        const payload = await decryptApprovalResume(row.resumePayload);
        if (
          payload.orgId !== ref.orgId ||
          payload.workspaceId !== ref.workspaceId ||
          payload.messageId !== row.messageId ||
          payload.capabilityName !== row.capabilityName ||
          payload.validatedDigest !== row.inputDigest
        )
          throw new ApprovalResumeError("payload_binding_changed");
        const cap = getCapability(payload.capabilityName);
        if (!cap) throw new ApprovalResumeError("capability_removed");
        const parsed = cap.input.safeParse(payload.rawInput);
        if (
          !parsed.success ||
          inputDigest(parsed.data) !== payload.validatedDigest
        )
          throw new ApprovalResumeError("input_schema_changed");
        const ctx: CapabilityContext = {
          orgId: ref.orgId,
          workspaceId: ref.workspaceId,
          userId: payload.requesterUserId,
          apiKeyId: null,
          requestId: crypto.randomUUID(),
          surface: "app",
          messageId: payload.messageId,
        };
        const [orgRoles, workspaceRoles] = await Promise.all([
          resolveActorOrgRoles(ctx.orgId, payload.requesterUserId),
          resolveActorWorkspaceRoles(
            ctx.orgId,
            ctx.workspaceId,
            payload.requesterUserId,
          ),
        ]);
        if (orgRoles.length === 0 && workspaceRoles.length === 0)
          throw new ApprovalResumeError("requester_access_revoked");
        bootstrapIAMRuntime();
        bootstrapBillingRuntime();
        bootstrapEntitlementRuntime();
        bootstrapDecisionRulesRuntime();
        const tools = await materializeTools(ctx, {
          allowlist: new Set([cap.name]),
          riskCeiling: payload.riskLevel,
          serverAllowlist: new Set(),
        });
        if (!Object.values(tools.nameMap).includes(cap.name)) {
          // The listing leaves out a tool a kill switch names (toolbelt.ts,
          // R4), so a missing tool can mean a switch rather than a changed
          // grant. Name the switch when it is one, as the check below does.
          const switched = await createKillSwitchGate(ctx).check({
            capabilityId: cap.name,
            readOnly: false,
          });
          throw new ApprovalResumeError(
            switched ? "kill_switch_active" : "tool_authorization_changed",
          );
        }
        const budgets = await getSpendBudgetStatuses();
        if (budgets.some((status) => status.budget.enabled && status.overLimit))
          throw new ApprovalResumeError("budget_exhausted");
        // invoke owns the fresh decision-rule check and its approval receipt.
        // A preflight gate would commit before run admission and commit again
        // when the canonical invocation evaluates the same standing rule.
        run = await openAssistantRun({
          orgId: ref.orgId,
          workspaceId: ref.workspaceId,
          userId: payload.requesterUserId,
          surface: "chat",
          instruction: `Resume approval ${row.publicId} from run ${row.runPublicId ?? "unrecorded"}`,
          maxSteps: 1,
          toolAllowlist: [cap.name],
          // The message belongs to the turn that parked the call, and that
          // turn's run is priced on it. Naming it here too would price the
          // same calls twice (#4167).
          originMessageId: null,
        });
        await withTenantDb((tx) =>
          tx
            .update(a)
            .set({ resumeRunPublicId: run!.runPublicId })
            .where(bounds),
        );
        ctx.executionStepId = run.runId;
        const intent = {
          seq: 1,
          requestId: ctx.requestId,
          toolName: cap.name,
          input: { inputDigest: payload.validatedDigest },
        };
        await run.toolCallStarted(intent);
        const killed = await createKillSwitchGate(ctx).check({
          capabilityId: cap.name,
          readOnly: false,
        });
        if (killed) throw new ApprovalResumeError("kill_switch_active");
        if (Date.now() >= row.expiresAt.getTime())
          throw new ApprovalResumeError("approval_expired");
        dispatched = true;
        await invoke(cap.name, payload.rawInput, ctx, {
          surface: "agent",
          requireFreshRules: true,
          runId: run.runId,
          assertValidatedInput: (value) => {
            if (inputDigest(value) !== payload.validatedDigest)
              throw new ApprovalResumeError("input_schema_changed");
          },
        });
        const status = cap.mode === "async" ? "dispatched" : "succeeded";
        await run.toolCall({
          ...intent,
          outcome: "completed",
          durationMs: Date.now() - now.getTime(),
          output: { status },
        });
        await run.seal({
          status: "completed",
          text: `Approval ${row.publicId}: ${status}`,
        });
        await finish(status, null);
        return status;
      } catch (error) {
        const reason =
          error instanceof ApprovalResumeError
            ? error.reason
            : error instanceof DecisionRuleDeniedError
              ? "decision_rule_denied"
              : error instanceof DecisionRuleApprovalRequiredError
                ? "new_rule_requires_approval"
                : error instanceof CapabilityError
                  ? error.code
                  : error instanceof DecisionRuleUnavailableError
                    ? "decision_rules_unavailable"
                    : dispatched
                      ? "execution_outcome_unknown"
                      : "authorization_or_admission_failed";
        const refusedBeforeHandler =
          error instanceof ApprovalResumeError ||
          error instanceof DecisionRuleDeniedError ||
          error instanceof DecisionRuleApprovalRequiredError ||
          error instanceof DecisionRuleUnavailableError ||
          (error instanceof CapabilityError &&
            error.code === "decision_rules_unavailable");
        const status =
          dispatched && !refusedBeforeHandler ? "indeterminate" : "failed";
        if (run) await run.seal({ status: "failed", error: reason });
        await finish(status, reason);
        return status;
      }
    },
  );
}
