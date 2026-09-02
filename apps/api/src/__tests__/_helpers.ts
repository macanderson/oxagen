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
 * Canonical test tenant IDs. These MUST be valid UUIDs: runInTenantScope()
 * fail-closes with a TenantScopeError on non-UUID org/workspace ids
 * (packages/tenancy assertUuid), and production tenant ids are always UUIDs.
 * Any route that enters a tenant scope (e.g. github-oauth /installations,
 * chat.stream) would otherwise 500 in tests with placeholder string ids.
 */
export const TEST_ORG_ID = "11111111-1111-1111-1111-111111111111";
export const TEST_WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";

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
    orgId: overrides?.orgId ?? TEST_ORG_ID,
    workspaceId: overrides?.workspaceId ?? TEST_WORKSPACE_ID,
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
export function makeOrgScopeOk(orgId = TEST_ORG_ID): OrgScopeResolution {
  return { ok: true, orgId };
}

/** Org not found or user not a member (resolver merges both cases). */
export function makeOrgNotFound(): OrgScopeResolution {
  return { ok: false, kind: "not_found" };
}

/** Successful workspace scope resolution. */
export function makeWorkspaceScopeOk(
  workspaceId = TEST_WORKSPACE_ID,
): WorkspaceScopeResolution {
  return { ok: true, workspaceId };
}

/** Workspace not found (also used for cross-tenant workspace from another org). */
export function makeWorkspaceNotFound(): WorkspaceScopeResolution {
  return { ok: false, kind: "not_found" };
}

/** Workspace exists in org but the user is not a member (cross-workspace within same org). */
export function makeWorkspaceNotMember(): WorkspaceScopeResolution {
  return { ok: false, kind: "not_member" };
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
