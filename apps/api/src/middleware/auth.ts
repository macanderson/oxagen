import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { createHash } from "node:crypto";
import { db, schema } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import type { AppEnv } from "../app.js";

/**
 * Resolves the caller via Better Auth session cookie or `Authorization:
 * Bearer <api-key>` header. The two paths produce different scope
 * primitives — a user session is tenant-agnostic until tenantMiddleware
 * picks a tenant; an API key is bound to (tenant_id, workspace_id) at
 * issuance and short-circuits later scoping.
 */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    await authenticateApiKey(c, auth.slice("Bearer ".length).trim());
    return next();
  }

  // Better Auth session cookie. The session token lives in the cookie
  // verbatim and is looked up in auth.sessions; expired rows fail closed.
  const cookieToken = readSessionCookie(c.req.header("cookie"));
  if (!cookieToken) throw new HTTPException(401, { message: "Missing credentials" });

  const d = db();
  const session = await d.query.sessions.findFirst({
    where: eq(schema.sessions.token, cookieToken),
    columns: { userId: true, expiresAt: true },
  });
  if (!session || session.expiresAt.getTime() < Date.now()) {
    throw new HTTPException(401, { message: "Session expired" });
  }
  c.set("userId", session.userId);
  c.set("apiKeyId", null);
  return next();
};

function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  // Better Auth defaults: cookie name "better-auth.session_token".
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === "better-auth.session_token" && v) return decodeURIComponent(v);
  }
  return null;
}

async function authenticateApiKey(c: Parameters<MiddlewareHandler<AppEnv>>[0], rawKey: string): Promise<void> {
  // Format: <prefix>_<secret>. The prefix is stored in plain text for index
  // lookup; the secret is hashed (sha256) and compared in constant-ish time
  // via direct equality after lookup.
  const sep = rawKey.indexOf("_");
  if (sep < 0) throw new HTTPException(401, { message: "Malformed API key" });
  const prefix = rawKey.slice(0, sep);
  const hash = createHash("sha256").update(rawKey).digest("hex");

  const d = db();
  const row = await d.query.apiKeys.findFirst({
    where: and(eq(schema.apiKeys.keyPrefix, prefix), isNull(schema.apiKeys.deletedAt)),
    columns: {
      id: true,
      keyHash: true,
      tenantId: true,
      workspaceId: true,
      expiresAt: true,
    },
  });
  if (!row || row.keyHash !== hash) throw new HTTPException(401, { message: "Invalid API key" });
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    throw new HTTPException(401, { message: "API key expired" });
  }

  c.set("userId", null);
  c.set("apiKeyId", row.id);
  // API keys pre-bind scope; downstream tenant/workspace middleware reads
  // these and skips slug resolution.
  c.set("tenantId", row.tenantId);
  c.set("workspaceId", row.workspaceId);
}
