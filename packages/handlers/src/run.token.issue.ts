import { resolveDataPlane } from "@oxagen/tenancy";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { runTokenIssue } from "@oxagen/oxagen/contracts/run.token.issue";
import {
  LEDGER_RUN_SCOPE_PURPOSE,
  LEDGER_RUN_TOKEN_TTL_MS,
} from "@oxagen/oxagen/ledger-run-token";
import {
  assertOrgRole,
  resolveActingUserId,
  resolveActorOrgRoles,
} from "@oxagen/iam/org-role";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { lockRunForControl } from "@oxagen/run-ledger";
import { and, eq } from "drizzle-orm";
import { generateApiKey } from "./lib/api-key-authz";
import { runScope } from "./run.list";

export const runTokenIssueHandler: CapabilityHandler<
  typeof runTokenIssue
> = async (input, ctx) => {
  if (ctx.apiKeyId)
    throw new HandlerError({
      code: "forbidden",
      reason: "operator_session_required",
    });
  const userId = await resolveActingUserId(ctx);
  if (!userId)
    throw new HandlerError({ code: "forbidden", reason: "operator_required" });
  await assertOrgRole(
    { ...ctx, userId },
    { org: ["Owner", "Admin"], workspace: ["Owner", "Member"] },
  );
  const scope = runScope(ctx);
  if ((await resolveDataPlane(scope.orgId, "postgres")).mode !== "shared")
    throw new HandlerError({
      code: "conflict",
      reason: "run_token_dedicated_plane_unsupported",
      message:
        "Run credentials require the shared Postgres plane until authentication can resolve dedicated-plane credentials",
    });
  return withTenantDb(async (tx) => {
    const run = await lockRunForControl(tx, scope, input.runId);
    if (!run)
      throw new HandlerError({ code: "not_found", reason: "run_not_found" });
    if (run.cancelled || !["pending", "running"].includes(run.status))
      throw new HandlerError({ code: "conflict", reason: "run_not_writable" });
    await assertRunParty(tx, scope, run.id, userId);
    const attempt = await tx.query.agentRunAttempts.findFirst({
      where: and(
        eq(schema.agentRunAttempts.publicId, input.attemptId),
        eq(schema.agentRunAttempts.runId, run.id),
        eq(schema.agentRunAttempts.orgId, scope.orgId),
        eq(schema.agentRunAttempts.workspaceId, scope.workspaceId),
      ),
      columns: { id: true },
    });
    if (!attempt)
      throw new HandlerError({
        code: "not_found",
        reason: "attempt_not_found",
      });
    const seal = await tx.query.agentRunAttemptSeals.findFirst({
      where: eq(schema.agentRunAttemptSeals.attemptId, attempt.id),
      columns: { id: true },
    });
    if (seal)
      throw new HandlerError({ code: "conflict", reason: "attempt_sealed" });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LEDGER_RUN_TOKEN_TTL_MS);
    const { rawKey, keyPrefix, keyHash } = generateApiKey();
    await tx.insert(schema.apiKeys).values({
      ...scope,
      name: `run ${input.runId}`,
      keyPrefix,
      keyHash,
      scope: {
        purpose: LEDGER_RUN_SCOPE_PURPOSE,
        run_id: run.id,
        attempt_id: attempt.id,
      },
      expiresAt,
      createdById: userId,
      updatedById: userId,
    });
    return { token: rawKey, expiresAt: expiresAt.toISOString() };
  });
};

/**
 * A V2 run row names the operator who delegated it
 * (`initiating_principal_id`) and the agent acting for them
 * (`agent_principal_id`). When it names either, the caller must be one of
 * them, or hold org Owner or Admin. Otherwise any workspace Member could mint
 * a credential for a colleague's live attempt and write frames the seal
 * records as that run's own evidence. A V1 row names neither, and the role
 * gate above remains its whole boundary.
 *
 * Every read goes through the caller's transaction: `iam.principals` is a
 * `workspace_nullable` table, so an org-level principal row is visible under
 * this workspace scope, and a second transaction here would hold one pool
 * connection while waiting for another.
 */
async function assertRunParty(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  runId: string,
  userId: string,
): Promise<void> {
  const [row] = await tx
    .select({
      initiating: schema.agentRuns.initiatingPrincipalId,
      agent: schema.agentRuns.agentPrincipalId,
    })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, runId));
  const parties = [row?.initiating, row?.agent].filter(
    (id): id is string => typeof id === "string",
  );
  if (parties.length === 0) return;
  const own = await tx
    .select({ id: schema.principals.id })
    .from(schema.principals)
    .where(
      and(
        eq(schema.principals.orgId, scope.orgId),
        eq(schema.principals.parentUserId, userId),
        eq(schema.principals.status, "active"),
      ),
    );
  if (own.some((principal) => parties.includes(principal.id))) return;
  const orgRoles = await resolveActorOrgRoles(scope.orgId, userId, tx);
  if (orgRoles.includes("Owner") || orgRoles.includes("Admin")) return;
  throw new HandlerError({
    code: "forbidden",
    reason: "not_run_principal",
    message:
      "Only the run's initiating principal, its agent, or an org Owner or Admin can issue its credential",
  });
}
