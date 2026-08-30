import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceBudgetPolicyRead } from "@oxagen/oxagen/contracts/workspace.budget_policy.read";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

type BudgetMode = "grace" | "prompt" | "enforce";
type EnforcementKind = "default" | "ceiling";

/** Normalize a free-text stored mode to one of the canonical values, defaulting to "enforce". */
function normalizeMode(raw: string | null | undefined): BudgetMode {
  return raw === "grace" || raw === "prompt" ? raw : "enforce";
}

/** Normalize a free-text stored enforcement to one of the canonical values, defaulting to "ceiling". */
function normalizeEnforcement(raw: string | null | undefined): EnforcementKind {
  return raw === "default" ? "default" : "ceiling";
}

export const workspaceBudgetPolicyReadHandler: CapabilityHandler<
  typeof workspaceBudgetPolicyRead
> = async (_input, ctx) => {
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "workspace.budget.policy.read: rejected — no workspace context",
    );
    throw new Error(
      "workspace.budget.policy.read requires a workspace context",
    );
  }

  const row = await withTenantDb((tx) =>
    tx.query.workspaceBudgetPolicy.findFirst({
      where: eq(schema.workspaceBudgetPolicy.workspaceId, ctx.workspaceId),
      columns: {
        enabled: true,
        limitUsd: true,
        mode: true,
        graceOveragePct: true,
        enforcement: true,
      },
    }),
  );

  // No policy row yet ⇒ the off-by-default, workspace-unrestricted policy.
  if (!row) {
    logger.debug(
      { workspaceId: ctx.workspaceId },
      "workspace.budget.policy.read: returning defaults (no governance)",
    );
    return {
      enabled: false,
      limitUsd: null,
      mode: "enforce",
      graceOveragePct: 0.25,
      enforcement: "ceiling",
    };
  }

  logger.debug(
    { workspaceId: ctx.workspaceId },
    "workspace.budget.policy.read: returning stored policy",
  );
  return {
    enabled: row.enabled,
    limitUsd: row.limitUsd ?? null,
    mode: normalizeMode(row.mode),
    graceOveragePct: row.graceOveragePct,
    enforcement: normalizeEnforcement(row.enforcement),
  };
};
