/**
 * POST /v1/auth/cli/token — public PKCE authorization-code exchange.
 *
 * The CLI calls this after the browser-based authorize flow completes.
 * No session or API key is required — the one-time code + PKCE verifier
 * are the security boundary (RFC 8252 + RFC 7636 S256).
 *
 * Security invariants:
 *   - `code` is single-use (consumeCliAuthCode atomically deletes on read).
 *   - `redirect_uri` must exactly match the value bound at authorize time.
 *   - PKCE S256 must verify: BASE64URL(SHA256(code_verifier)) == codeChallenge.
 *   - `code`, `code_verifier`, and the minted `token` are never logged.
 */
import { Hono } from "hono";
import { z } from "zod";
import { consumeCliAuthCode, verifyPkceS256 } from "@oxagen/auth/cli-auth";
import { schema, withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { generateApiKey } from "@oxagen/handlers";
import type { AppEnv } from "../../app";

const BodySchema = z.object({
  code: z.string().min(1),
  code_verifier: z.string().min(1),
  redirect_uri: z.string().min(1),
});

const INVALID_GRANT = {
  error: "invalid_grant",
  error_description: "Authorization code is invalid or expired",
} as const;

export const authCliTokenRoute = new Hono<AppEnv>();

authCliTokenRoute.post("/token", async (c) => {
  // ── Body validation ──────────────────────────────────────────────────────
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await c.req.json());
  } catch {
    return c.json(
      { error: "invalid_request", error_description: "Invalid request body" },
      400,
    );
  }

  const { code, code_verifier, redirect_uri } = body;

  // ── Redeem single-use authorization code ─────────────────────────────────
  // consumeCliAuthCode atomically deletes the code row; a replayed code finds
  // nothing and returns null, so replay is structurally impossible.
  const data = await consumeCliAuthCode(code, Date.now());
  if (!data) {
    return c.json(INVALID_GRANT, 400);
  }

  // ── Redirect URI binding check ────────────────────────────────────────────
  // The exact URI must match what the CLI presented at authorize time so a
  // code intercepted in transit cannot be exchanged by a different listener.
  if (data.redirectUri !== redirect_uri) {
    return c.json(INVALID_GRANT, 400);
  }

  // ── PKCE S256 verification ────────────────────────────────────────────────
  // Constant-time comparison — see verifyPkceS256 in @oxagen/auth/cli-auth.
  if (!verifyPkceS256(code_verifier, data.codeChallenge)) {
    return c.json(INVALID_GRANT, 400);
  }

  // ── Mint API key ──────────────────────────────────────────────────────────
  // Scope is derived from the approved code — no trust in caller-supplied ids.
  const { rawKey, keyPrefix, keyHash } = generateApiKey();

  await withSystemDb(async (tx) => {
    await tx.insert(schema.apiKeys).values({
      orgId: data.orgId,
      workspaceId: data.workspaceId,
      keyPrefix,
      keyHash,
      name: data.label,
      scope: {},
      createdByUserId: data.userId,
      updatedByUserId: data.userId,
    });
  });

  // ── Audit event (fire-and-forget) ─────────────────────────────────────────
  emitSecurityEvent({
    eventType: "api_key.created",
    actorUserId: data.userId,
    orgId: data.orgId,
    workspaceId: null,
    capability: "create_api_key",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: null,
  });

  // NEVER log rawKey, code, or code_verifier.
  return c.json(
    {
      token: rawKey,
      orgSlug: data.orgSlug,
      workspaceSlug: data.workspaceSlug,
    },
    200,
  );
});
