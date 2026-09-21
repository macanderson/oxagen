import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { runFramesIngest } from "@oxagen/oxagen/contracts/run.frames.ingest";
import { withTenantDb } from "@oxagen/database";
import { createPostgresRunStore } from "@oxagen/run-ledger";
import { deferredEvidenceBodies } from "@oxagen/run-ledger/evidence-store";
import { readRunToken, refreshRunToken, tokenRefused } from "./lib/run-token";
import { runScope } from "./run.list";

export const runFramesIngestHandler: CapabilityHandler<
  typeof runFramesIngest
> = async (input, ctx) => {
  const apiKeyId = ctx.apiKeyId;
  if (!apiKeyId) throw tokenRefused();
  const scope = runScope(ctx);
  const token = await withTenantDb((tx) =>
    readRunToken(tx, scope, apiKeyId, new Date()),
  );
  let expiresAt: Date | undefined;
  const store = createPostgresRunStore({
    bodies: deferredEvidenceBodies,
    authorizeAppend: async (tx, attempt) => {
      const now = new Date();
      const current = await readRunToken(tx, scope, apiKeyId, now, true);
      if (
        current.claims.run_id !== attempt.run_id ||
        current.claims.attempt_id !== attempt.attempt_id ||
        attempt.org_id !== scope.orgId ||
        attempt.workspace_id !== scope.workspaceId
      )
        throw tokenRefused();
      expiresAt = await refreshRunToken(tx, apiKeyId, now);
    },
  });
  try {
    const result = await store.appendAttemptBatch({
      attemptId: token.claims.attempt_id,
      events: input.events.map(({ body, ...event }) => ({
        ...event,
        ...(body
          ? {
              body: {
                contentType: body.contentType,
                bytes: Buffer.from(body.base64, "base64"),
              },
            }
          : {}),
      })),
    });
    if (!expiresAt) throw new Error("Run credential refresh was not recorded");
    return {
      events: result.events,
      lastAttemptSeq: result.lastAttemptSeq,
      lastRunSeq: result.lastRunSeq,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "run_attempt_not_writable"
    )
      throw new HandlerError({
        code: "conflict",
        reason: "run_not_writable",
        message: "The attempt is sealed or its run was cancelled",
      });
    throw error;
  }
};
