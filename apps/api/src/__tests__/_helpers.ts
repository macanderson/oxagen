/**
 * Shared test helpers for apps/api unit tests.
 *
 * - makeRequest: build a WHATWG Request against http://localhost
 * - fetchApp: call app.fetch with a Request and return the Response
 * - Mock factories for the auth seam (api-key, session)
 *
 * All individual test files import from here — never re-declare setup.
 */

import type { ApiKeyResolution } from "@oxagen/auth";
import type { WorkspaceScopeResolution } from "@oxagen/auth";
import type { OrgScopeResolution } from "@oxagen/auth";

// Re-export for convenience so tests don't need to reach into @oxagen/auth
export type { ApiKeyResolution, WorkspaceScopeResolution, OrgScopeResolution };

/**
 * Build a WHATWG Request pointing at http://localhost.
 * Accepts a path (must start with `/`) and standard RequestInit options.
 */
export function makeRequest(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

/**
 * Call app.fetch with a pre-built Request.
 * Import `app` from `../app` AFTER all vi.mock() calls are in place.
 */
export async function fetchApp(
  app: { fetch: (req: Request) => Promise<Response> },
  req: Request,
): Promise<Response> {
  return app.fetch(req);
}

// ── Auth seam mock factories ──────────────────────────────────────────────────

/** Successful API-key resolution — pre-binds org + workspace scope. */
export function makeApiKeyOk(
  overrides?: Partial<{ apiKeyId: string; orgId: string; workspaceId: string }>,
): ApiKeyResolution {
  return {
    ok: true,
    apiKeyId: overrides?.apiKeyId ?? "key-id-test",
    orgId: overrides?.orgId ?? "org-id-test",
    workspaceId: overrides?.workspaceId ?? "ws-id-test",
  };
}

/** Malformed key — missing underscore separator. */
export function makeApiKeyMalformed(): ApiKeyResolution {
  return { ok: false, kind: "malformed" };
}

/** Key not found in DB or hash mismatch. */
export function makeApiKeyInvalid(): ApiKeyResolution {
  return { ok: false, kind: "invalid" };
}

/** Key exists but expiresAt < now. */
export function makeApiKeyExpired(): ApiKeyResolution {
  return { ok: false, kind: "expired" };
}

/** Valid session — carries userId. */
export function makeSessionValid(userId = "user-id-test"): { userId: string } {
  return { userId };
}

/** Successful org scope resolution. */
export function makeOrgScopeOk(orgId = "org-id-test"): OrgScopeResolution {
  return { ok: true, orgId };
}

/** Org not found or user not a member (resolver merges both cases). */
export function makeOrgNotFound(): OrgScopeResolution {
  return { ok: false, kind: "not_found" };
}

/** Successful workspace scope resolution. */
export function makeWorkspaceScopeOk(workspaceId = "ws-id-test"): WorkspaceScopeResolution {
  return { ok: true, workspaceId };
}

/** Workspace not found (also used for cross-tenant workspace from another org). */
export function makeWorkspaceNotFound(): WorkspaceScopeResolution {
  return { ok: false, kind: "not_found" };
}

/**
 * Build an Authorization header value for an API key.
 */
export function bearerHeader(key: string): string {
  return `Bearer ${key}`;
}

/**
 * UUID v4 regex — used to assert requestId shape.
 */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
