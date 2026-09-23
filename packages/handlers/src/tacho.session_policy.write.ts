import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { tachoSessionPolicyWrite } from "@oxagen/oxagen/contracts/tacho.session_policy.write";
import { BUNDLE_FEATURE_INDEPENDENT_MODELS } from "@oxagen/tacho";
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq, ne } from "drizzle-orm";
import {
  readTachoSessionPolicyIn,
  type SessionPolicyTx,
  type TachoSessionPolicy,
} from "./lib/tacho-session-policy";
import { logger } from "./logger";

/**
 * Set the workspace's wrapped-session policy, and say how far it reaches.
 *
 * Workspace Owners and Admins arm model lists independently of agent budgets.
 * Only hosts advertising the independent model clause receive the lists.
 * The legacy workspace ceiling remains recorded and does not arm a budget.
 *
 * The reach is part of the answer, not a nicety. `models` rides a gated bundle
 * field — a daemon built before the field never receives one, because the
 * host's bundle schema is `.strict()` and would reject the whole mandate. So a
 * saved allowlist can be a correct record of a decision and still govern no
 * machine, and a settings page that showed only the saved value would report
 * that as success. The counts here are what lets the surface say which it is.
 *
 * The role gate runs here, not in the kernel. `check-iam.ts` fast-paths a
 * non-enterprise human principal (INV-29), so on a Free, Build or Scale org
 * the contract's `defaultRoles` is documentation and the kernel admits every
 * role. `set_spend_budget` and the enrollment-token writes gate in the handler
 * for the same reason. Without this call a workspace Member, a Viewer, or a
 * personal API key could set `mode` to `observed`, clear the session ceiling,
 * or null the allowlist, which disarms the gateway this capability exists to
 * arm. Hiding the panel in the app is not a gate; the API is the surface.
 */
export const tachoSessionPolicyWriteHandler: CapabilityHandler<
  typeof tachoSessionPolicyWrite
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "update_tacho_session_policy: rejected — no workspace context",
    );
    throw new Error("update_tacho_session_policy requires a workspace context");
  }
  const workspaceId = ctx.workspaceId;
  const orgId = ctx.orgId;

  // Matches the contract's defaultRoles. An API-key call acts as the key's
  // creator, which is what resolveActingUserId answers.
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: ["Owner", "Admin"], workspace: ["Owner", "Admin"] },
  );

  return withTenantDb(async (tx) => {
    const current = await readTachoSessionPolicyIn(
      tx as unknown as SessionPolicyTx,
      workspaceId,
    );
    const next: TachoSessionPolicy = {
      mode: input.mode ?? current.mode,
      sessionLimitUsd:
        "sessionLimitUsd" in input
          ? (input.sessionLimitUsd ?? null)
          : current.sessionLimitUsd,
      modelAllow:
        "modelAllow" in input ? (input.modelAllow ?? null) : current.modelAllow,
      modelDeny: input.modelDeny ?? current.modelDeny,
    };

    if (
      next.mode === "enforced" &&
      next.modelAllow === null &&
      next.modelDeny.length === 0
    ) {
      throw new CapabilityError(
        "update_tacho_session_policy",
        "invalid_input",
        "Set an allowed or denied model list before enforcing it. Run budgets are set on the agent mandate.",
      );
    }

    const values = {
      mode: next.mode,
      sessionLimitUsd: next.sessionLimitUsd,
      modelAllow: next.modelAllow,
      modelDeny: next.modelDeny,
    };
    const existing = await tx.query.tachoSessionPolicy.findFirst({
      where: eq(schema.tachoSessionPolicy.workspaceId, workspaceId),
      columns: { id: true },
    });
    if (existing) {
      await tx
        .update(schema.tachoSessionPolicy)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(schema.tachoSessionPolicy.workspaceId, workspaceId));
    } else {
      await tx
        .insert(schema.tachoSessionPolicy)
        .values({ orgId, workspaceId, ...values });
    }

    const hosts = await tx.query.tachoHosts.findMany({
      where: and(
        eq(schema.tachoHosts.workspaceId, workspaceId),
        ne(schema.tachoHosts.status, "revoked"),
      ),
      columns: { bundleFeatures: true },
    });
    const hostsEnforcingModels = hosts.filter((host) =>
      (host.bundleFeatures ?? []).includes(BUNDLE_FEATURE_INDEPENDENT_MODELS),
    ).length;

    logger.info(
      { workspaceId, next, hosts: hosts.length, hostsEnforcingModels },
      "update_tacho_session_policy: policy updated",
    );
    return {
      ...next,
      reach: { hosts: hosts.length, hostsEnforcingModels },
    };
  });
};
