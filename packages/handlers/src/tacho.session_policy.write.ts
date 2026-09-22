import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { tachoSessionPolicyWrite } from "@oxagen/oxagen/contracts/tacho.session_policy.write";
import { BUNDLE_FEATURE_MODEL_ALLOWLIST } from "@oxagen/tacho";
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
 * **It reaches no machine today, and `enforced` is refused for that reason.**
 * No bundle carries a `models` clause, and `budget.mode` is set from the
 * agent's own mandate budget (#3710), so a policy saved here records a
 * decision and governs nothing. Accepting `enforced` would put a word in the
 * record that no enforcer reads, which is the defect the gateway audit found
 * wearing a switch. The write stays open so the decision can be recorded and
 * read back before the clause exists.
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

    // Nothing enforces this policy yet, so nothing may claim to. The database
    // carries the weaker rule — enforced with no clause to enforce — and this
    // is the stronger one: enforced with no reader at all. Refusing it here is
    // what lets the person read why, instead of a constraint name.
    if (next.mode === "enforced") {
      throw new CapabilityError(
        "update_tacho_session_policy",
        "invalid_input",
        "Enforced is not available yet. The gateway does not read this policy, so every enrolled machine keeps calling any model whatever it says. Save the lists as metered and they apply when the gateway reads them.",
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
      (host.bundleFeatures ?? []).includes(BUNDLE_FEATURE_MODEL_ALLOWLIST),
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
