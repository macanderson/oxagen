import { resolveDataPlane } from "@oxagen/tenancy";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { runTokenIssue } from "@oxagen/oxagen/contracts/run.token.issue";
import {
  LEDGER_RUN_SCOPE_PURPOSE,
  LEDGER_RUN_TOKEN_TTL_MS,
} from "@oxagen/oxagen/ledger-run-token";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { schema, withTenantDb } from "@oxagen/database";
import { lockRunForControl } from "@oxagen/run-ledger";
import { and, eq } from "drizzle-orm";
import { generateApiKey } from "./lib/api-key-authz";
import { runScope } from "./run.list";

export const runTokenIssueHandler: CapabilityHandler<
  typeof runTokenIssue
> = async (input, ctx) => {
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
