import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceBudgetPolicyWrite } from "@oxagen/oxagen/contracts/workspace.budget_policy.write";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";

type BudgetMode = "grace" | "prompt" | "enforce";
type EnforcementKind = "default" | "ceiling";

function normalizeMode(raw: string | null | undefined): BudgetMode {
  return raw === "grace" || raw === "prompt" ? raw : "enforce";
}

function normalizeEnforcement(raw: string | null | undefined): EnforcementKind {
  return raw === "default" ? "default" : "ceiling";
}

export const workspaceBudgetPolicyWriteHandler: CapabilityHandler<
  typeof workspaceBudgetPolicyWrite
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "workspace.budget.policy.write: rejected — no workspace context",
    );
    throw new Error(
      "workspace.budget.policy.write requires a workspace context",
    );
  }
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(workspaceBudgetPolicyWrite, ctx);

  const workspaceId = ctx.workspaceId;

  // Read the current policy (if it exists).
  const existing = await withTenantDb((tx) =>
    tx.query.workspaceBudgetPolicy.findFirst({
      where: eq(schema.workspaceBudgetPolicy.workspaceId, workspaceId),
    }),
  );

  // Build the next merged state from input + existing (or defaults).
  const next: {
    enabled: boolean;
    limitUsd: number | null;
    mode: "grace" | "prompt" | "enforce";
    graceOveragePct: number;
    enforcement: "default" | "ceiling";
  } = {
    enabled:
      input.enabled !== undefined
        ? input.enabled
        : (existing?.enabled ?? false),
    limitUsd:
      "limitUsd" in input
        ? (input.limitUsd ?? null)
        : (existing?.limitUsd ?? null),
    mode: input.mode !== undefined ? input.mode : normalizeMode(existing?.mode),
    graceOveragePct:
      input.graceOveragePct !== undefined
        ? input.graceOveragePct
        : (existing?.graceOveragePct ?? 0.25),
    enforcement:
      input.enforcement !== undefined
        ? input.enforcement
        : normalizeEnforcement(existing?.enforcement),
  };

  // Upsert the policy row.
  if (existing) {
    await withTenantDb((tx) =>
      tx
        .update(schema.workspaceBudgetPolicy)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(schema.workspaceBudgetPolicy.workspaceId, workspaceId)),
    );
  } else {
    await withTenantDb((tx) =>
      tx.insert(schema.workspaceBudgetPolicy).values({
        orgId: ctx.orgId!,
        workspaceId,
        ...next,
      }),
    );
  }

  logger.info(
    { workspaceId, next, isInsert: !existing },
    "workspace.budget.policy.write: policy updated",
  );

  return next;
};
