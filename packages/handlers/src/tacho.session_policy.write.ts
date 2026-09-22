import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { tachoSessionPolicyWrite } from "@oxagen/oxagen/contracts/tacho.session_policy.write";
import { BUNDLE_FEATURE_MODEL_ALLOWLIST } from "@oxagen/tacho";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, ne } from "drizzle-orm";
import {
  hasEnforceableClause,
  readTachoSessionPolicyIn,
  type SessionPolicyTx,
  type TachoSessionPolicy,
} from "./lib/tacho-session-policy";
import { logger } from "./logger";

/**
 * Set the workspace's wrapped-session policy, and say how far it reaches.
 *
 * The reach is part of the answer, not a nicety. `models` rides a gated bundle
 * field — a daemon built before the field never receives one, because the
 * host's bundle schema is `.strict()` and would reject the whole mandate. So a
 * saved allowlist can be a correct record of a decision and still govern no
 * machine, and a settings page that showed only the saved value would report
 * that as success. The counts here are what lets the surface say which it is.
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

    // The database carries this rule too. Refusing it here is what lets the
    // person read why, instead of a constraint name.
    if (next.mode === "enforced" && !hasEnforceableClause(next)) {
      throw new CapabilityError(
        "update_tacho_session_policy",
        "invalid_input",
        "Enforced needs something to enforce: set a session limit, an allowed-model list, or a denied-model list. A policy that enforces nothing meters exactly like observed and would say otherwise.",
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
