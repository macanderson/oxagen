import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { runFramesIngest } from "@oxagen/oxagen/contracts/run.frames.ingest";
import { withTenantDb } from "@oxagen/database";
import {
  createPostgresRunStore,
  isAttemptNotWritableError,
  isRunEventInputError,
} from "@oxagen/run-ledger";
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
  await assertOrgRole(
    { ...ctx, userId: await resolveActingUserId(ctx) },
    { org: ["Owner", "Admin"], workspace: ["Owner", "Member"] },
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
      // The receipt names each event by its attempt and run sequence and its
      // digest. The row's own uuid stays inside: `agent_run_events` has no
      // public id, and a producer addresses an event by sequence (#3665).
      events: result.events.map(
        ({ attemptSeq, runSeq, eventDigest, idempotent }) => ({
          attemptSeq,
          runSeq,
          eventDigest,
          idempotent,
        }),
      ),
      lastAttemptSeq: result.lastAttemptSeq,
      lastRunSeq: result.lastRunSeq,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    // An event the producer got wrong (an unknown type, a payload off its
    // schema, both or neither of `payload` and `encryptedPayloadRef`) is
    // refused before any SQL runs. It is the caller's fault, so it answers
    // 400 rather than the 500 an unmapped ledger error becomes (#3665).
    if (isRunEventInputError(error))
      throw new CapabilityError(
        runFramesIngest.name,
        "invalid_input",
        (error as Error).message,
      );
    if (isAttemptNotWritableError(error))
      throw new HandlerError({
        code: "conflict",
        reason: "run_not_writable",
        message:
          "The attempt is sealed, or its evidence ingress is paused or cancelled",
      });
    throw error;
  }
};
