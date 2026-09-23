import { createHash, randomBytes } from "node:crypto";
import { schema, withTenantDb, withSystemDb } from "@oxagen/database";
import {
  createIngestionCryptoAdapter,
  resolveIngestionCryptoAdapterForKeyId,
  encrypt,
  decrypt,
} from "@oxagen/crypto";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assertRunOutcomesAllowed,
  type RunOutcomesScope,
} from "./run-outcomes-policy";

const STATE_PREFIX = "run_linear_oauth:";
const stateSchema = z.object({
  orgId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  codeVerifier: z.string(),
  redirectUri: z.string().url(),
});
const envelopeSchema = z.object({ keyId: z.string(), ciphertext: z.string() });
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().finite(),
  scope: z.union([z.string(), z.array(z.string())]),
  token_type: z.literal("Bearer").optional(),
});

export function linearOAuthConfigured(): boolean {
  return Boolean(
    process.env["LINEAR_OAUTH_CLIENT_ID"] && process.env["APP_URL"],
  );
}

async function wrapToken(value: string) {
  const { adapter, keyId } = createIngestionCryptoAdapter();
  return {
    keyId,
    ciphertext: (await encrypt(value, keyId, { adapter })).toString("base64"),
  };
}
async function unwrapToken(value: unknown): Promise<string> {
  const envelope = envelopeSchema.parse(value);
  const { adapter } = resolveIngestionCryptoAdapterForKeyId(envelope.keyId);
  return (
    await decrypt(Buffer.from(envelope.ciphertext, "base64"), envelope.keyId, {
      adapter,
    })
  ).toString("utf8");
}
function scopesOf(value: string | string[]): string[] {
  return typeof value === "string"
    ? value.split(/[ ,]+/).filter(Boolean)
    : value;
}
function requireIssueScope(scopes: string[]) {
  if (
    !scopes.includes("read") ||
    !(scopes.includes("issues:create") || scopes.includes("write"))
  ) {
    throw new HandlerError({
      code: "forbidden",
      reason: "linear_issue_scope_required",
    });
  }
}
function clientId(): string {
  const value = process.env["LINEAR_OAUTH_CLIENT_ID"];
  if (!value)
    throw new HandlerError({
      code: "conflict",
      reason: "linear_oauth_not_configured",
    });
  return value;
}

export async function beginLinearAuthorization(
  scope: RunOutcomesScope,
  userId: string,
): Promise<{ authorizeUrl: string }> {
  await assertRunOutcomesAllowed(scope);
  const oauthClientId = clientId();
  const appUrl = process.env["APP_URL"];
  if (!appUrl)
    throw new HandlerError({
      code: "conflict",
      reason: "linear_oauth_not_configured",
    });
  const redirectUri = new URL("/api/run-outcomes/linear/callback", appUrl).href;
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  const id = STATE_PREFIX + state;
  // tenancy: global OAuth state is bound to the verified orgId, workspaceId and acting userId.
  await withSystemDb((tx) =>
    tx.insert(schema.verifications).values({
      id,
      identifier: id,
      value: JSON.stringify({ ...scope, userId, codeVerifier, redirectUri }),
      expiresAt: new Date(Date.now() + 600_000),
    }),
  );
  const url = new URL("https://linear.app/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: oauthClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "read,issues:create",
    actor: "app",
    state,
    code_challenge: createHash("sha256")
      .update(codeVerifier)
      .digest("base64url"),
    code_challenge_method: "S256",
    prompt: "consent",
  }).toString();
  return { authorizeUrl: url.href };
}

/** Exact actor/scope binding is checked before the single-use state is consumed. */
export async function completeLinearAuthorization(
  scope: RunOutcomesScope,
  userId: string,
  state: string,
  code: string,
): Promise<{ connectionId: string }> {
  await assertRunOutcomesAllowed(scope);
  const stateId = STATE_PREFIX + state;
  // tenancy: global state lookup is filtered by nonce and verified against orgId, workspaceId and userId before consumption.
  const stored = await withSystemDb(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.verifications)
      .where(
        and(
          eq(schema.verifications.id, stateId),
          gt(schema.verifications.expiresAt, new Date()),
        ),
      )
      .for("update");
    if (!row)
      throw new HandlerError({
        code: "forbidden",
        reason: "linear_oauth_state_expired",
      });
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.value);
    } catch {
      throw new HandlerError({
        code: "forbidden",
        reason: "linear_oauth_state_invalid",
      });
    }
    const parsed = stateSchema.safeParse(decoded);
    if (!parsed.success)
      throw new HandlerError({
        code: "forbidden",
        reason: "linear_oauth_state_invalid",
      });
    const data = parsed.data;
    if (
      data.orgId !== scope.orgId ||
      data.workspaceId !== scope.workspaceId ||
      data.userId !== userId
    )
      throw new HandlerError({
        code: "forbidden",
        reason: "linear_oauth_state_mismatch",
      });
    await tx
      .delete(schema.verifications)
      .where(eq(schema.verifications.id, stateId));
    return data;
  });
  await assertRunOutcomesAllowed(scope);
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId(),
      redirect_uri: stored.redirectUri,
      code,
      code_verifier: stored.codeVerifier,
    }),
  });
  if (!response.ok)
    throw new HandlerError({
      code: "conflict",
      reason: "linear_oauth_exchange_failed",
    });
  const token = tokenSchema.parse(await response.json());
  const scopes = scopesOf(token.scope);
  requireIssueScope(scopes);
  const identity = await linearGraphql(
    scope,
    token.access_token,
    "query { organization { id name } viewer { id } }",
    {},
    z.object({
      organization: z.object({ id: z.string(), name: z.string() }),
      viewer: z.object({ id: z.string() }),
    }),
  );
  const accessTokenEnc = await wrapToken(token.access_token);
  const refreshTokenEnc = await wrapToken(token.refresh_token);
  await assertRunOutcomesAllowed(scope);
  return withTenantDb(async (tx) => {
    const [connection] = await tx
      .insert(schema.sourceConnections)
      .values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        connectorId: "linear",
        displayName: identity.organization.name,
        authScheme: "oauth2_authorization_code",
        deliveryMethod: "manual",
        deliveryConfig: {
          runOutcomesOnly: true,
          linearOrganizationId: identity.organization.id,
        },
        status: "connected",
      })
      .returning({
        id: schema.sourceConnections.id,
        publicId: schema.sourceConnections.publicId,
      });
    if (!connection)
      throw new HandlerError({
        code: "conflict",
        reason: "linear_connection_not_saved",
      });
    await tx.insert(schema.oauthTokens).values({
      connectionId: connection.id,
      accessTokenEnc,
      refreshTokenEnc,
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
      scopes,
      providerUserId: identity.viewer.id,
      providerAccountId: identity.organization.id,
    });
    return { connectionId: connection.publicId };
  });
}

/** Guard every request, including reads that carry a provider credential. */
export async function linearGraphql<T>(
  scope: RunOutcomesScope,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  output: z.ZodType<T>,
): Promise<T> {
  await assertRunOutcomesAllowed(scope);
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok)
    throw new HandlerError({
      code: "conflict",
      reason:
        response.status === 401
          ? "linear_reauthorization_required"
          : "linear_request_failed",
    });
  const body = (await response.json()) as {
    data?: unknown;
    errors?: unknown[];
  };
  if (body.errors?.length)
    throw new HandlerError({
      code: "conflict",
      reason: "linear_graphql_failed",
    });
  return output.parse(body.data);
}

/** Row locking serializes refresh rotation across workers. Tokens never leave server code. */
export async function resolveLinearIssueToken(
  scope: RunOutcomesScope,
  connectionPublicId: string,
): Promise<string> {
  await assertRunOutcomesAllowed(scope);
  return withTenantDb(async (tx) => {
    const [connection] = await tx
      .select({ id: schema.sourceConnections.id })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.publicId, connectionPublicId),
          eq(schema.sourceConnections.orgId, scope.orgId),
          eq(schema.sourceConnections.workspaceId, scope.workspaceId),
          eq(schema.sourceConnections.connectorId, "linear"),
          sql`${schema.sourceConnections.deliveryConfig}->>'runOutcomesOnly' = 'true'`,
          eq(schema.sourceConnections.status, "connected"),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .for("update");
    if (!connection)
      throw new HandlerError({
        code: "not_found",
        reason: "linear_connection_not_found",
      });
    const [stored] = await tx
      .select()
      .from(schema.oauthTokens)
      .where(eq(schema.oauthTokens.connectionId, connection.id))
      .for("update");
    if (!stored)
      throw new HandlerError({
        code: "conflict",
        reason: "linear_reauthorization_required",
      });
    requireIssueScope(stored.scopes);
    if (stored.expiresAt && stored.expiresAt.getTime() > Date.now() + 60_000)
      return unwrapToken(stored.accessTokenEnc);
    if (!stored.refreshTokenEnc)
      throw new HandlerError({
        code: "conflict",
        reason: "linear_reauthorization_required",
      });
    await assertRunOutcomesAllowed(scope);
    const response = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId(),
        refresh_token: await unwrapToken(stored.refreshTokenEnc),
      }),
    });
    if (!response.ok)
      throw new HandlerError({
        code: "conflict",
        reason: "linear_reauthorization_required",
      });
    const token = tokenSchema.parse(await response.json());
    const scopes = scopesOf(token.scope);
    requireIssueScope(scopes);
    await tx
      .update(schema.oauthTokens)
      .set({
        accessTokenEnc: await wrapToken(token.access_token),
        refreshTokenEnc: await wrapToken(token.refresh_token),
        expiresAt: new Date(Date.now() + token.expires_in * 1000),
        scopes,
        lastRefreshedAt: new Date(),
        updatedAt: new Date(),
        refreshFailureCount: 0,
      })
      .where(eq(schema.oauthTokens.connectionId, connection.id));
    return token.access_token;
  });
}
