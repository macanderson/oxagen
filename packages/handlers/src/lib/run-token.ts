import { z } from "zod";
import { schema, type Tx } from "@oxagen/database";
import {
  LEDGER_RUN_SCOPE_PURPOSE,
  LEDGER_RUN_TOKEN_TTL_MS,
} from "@oxagen/oxagen/ledger-run-token";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { and, eq, isNull, sql } from "drizzle-orm";

export const ledgerTokenScope = z
  .object({
    purpose: z.literal(LEDGER_RUN_SCOPE_PURPOSE),
    run_id: z.string().uuid(),
    attempt_id: z.string().uuid(),
  })
  .strict();
export const tokenRefused = () =>
  new HandlerError({
    code: "forbidden",
    reason: "run_token_invalid",
    message:
      "The run credential is expired, revoked, or bound to another attempt",
  });

/** Rechecked while holding the run lock, then the key lock. */
export async function readRunToken(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  apiKeyId: string,
  now: Date,
  lock = false,
) {
  const query = tx
    .select({
      id: schema.apiKeys.id,
      scope: schema.apiKeys.scope,
      expiresAt: schema.apiKeys.expiresAt,
    })
    .from(schema.apiKeys)
    .where(
      and(
        eq(schema.apiKeys.id, apiKeyId),
        eq(schema.apiKeys.orgId, scope.orgId),
        eq(schema.apiKeys.workspaceId, scope.workspaceId),
        isNull(schema.apiKeys.deletedAt),
      ),
    )
    .limit(1);
  const [key] = await (lock ? query.for("update") : query);
  const claims = ledgerTokenScope.safeParse(key?.scope);
  if (
    !key ||
    !claims.success ||
    !key.expiresAt ||
    key.expiresAt.getTime() <= now.getTime()
  )
    throw tokenRefused();
  return { key, claims: claims.data };
}

export async function refreshRunToken(tx: Tx, apiKeyId: string, now: Date) {
  const expiresAt = new Date(now.getTime() + LEDGER_RUN_TOKEN_TTL_MS);
  await tx
    .update(schema.apiKeys)
    .set({ expiresAt, updatedAt: now })
    .where(eq(schema.apiKeys.id, apiKeyId));
  return expiresAt;
}

export async function revokeRunTokens(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  runId: string,
  now: Date,
) {
  await tx
    .update(schema.apiKeys)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.apiKeys.orgId, scope.orgId),
        eq(schema.apiKeys.workspaceId, scope.workspaceId),
        isNull(schema.apiKeys.deletedAt),
        sql`${schema.apiKeys.scope}->>'purpose' = ${LEDGER_RUN_SCOPE_PURPOSE}`,
        sql`${schema.apiKeys.scope}->>'run_id' = ${runId}`,
      ),
    );
}
