/**
 * route.test.ts — regression tests for GET /api/v1/mcp/oauth/authorize.
 *
 * The route resolves the org and asserts the caller is an MCP manager via
 * `@/lib/resolve-org`, whose gates signal denial by throwing `notFound()`
 * (an HTTPAccessFallbackError carrying digest `NEXT_HTTP_ERROR_FALLBACK;404`).
 *
 * Route Handlers have NO not-found render boundary, so before the fix that
 * thrown sentinel escaped the handler uncaught — Vercel reported it as
 * FUNCTION_INVOCATION_FAILED / HTTP 502 (the production bug). These tests
 * assert the handler now returns a real, handled Response for every failing
 * condition and NEVER rejects:
 *   - notFound() from a resolve-org gate -> 404 JSON (not an unhandled throw)
 *   - an unexpected DB/infra throw       -> 500 JSON (not a 502 crash)
 *   - the success path                   -> redirect to the authorization server
 *
 * Route handlers are excluded from this package's coverage gate (they are
 * e2e-tested against the real stack), but this unit test is the regression
 * guard that fails on the pre-fix code and passes on the fixed code.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockResolveOrg,
  mockAssertMcpManager,
  mockWithSystemDb,
  mockMcpAuth,
  mockProviderInstances,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockAssertMcpManager: vi.fn(),
  mockWithSystemDb: vi.fn(),
  mockMcpAuth: vi.fn(),
  mockProviderInstances: [] as Array<{ pendingRedirect: URL | null }>,
}));

vi.mock("@/lib/session", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  assertMcpManager: mockAssertMcpManager,
}));
vi.mock("@oxagen/database", () => ({
  withSystemDb: mockWithSystemDb,
  schema: {
    pluginInstalledPlugins: { id: "id", orgId: "orgId", endpointUrl: "endpointUrl" },
    workspaces: { id: "id", orgId: "orgId", slug: "slug" },
  },
}));
vi.mock("@oxagen/plugins", () => ({
  // Construct a fake provider whose pendingRedirect the route reads; the route
  // mutates `pendingRedirect` via the (mocked) mcpAuth call, so we expose the
  // instance to the test through mockProviderInstances.
  DbOAuthClientProvider: vi.fn().mockImplementation(() => {
    const inst = { pendingRedirect: null as URL | null };
    mockProviderInstances.push(inst);
    return inst;
  }),
}));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({ auth: mockMcpAuth }));

import { GET } from "./route";

/** Build the HTTPAccessFallbackError shape that notFound() throws. */
function notFoundSentinel(): Error {
  const e = new Error("NEXT_HTTP_ERROR_FALLBACK");
  (e as Error & { digest: string }).digest = "NEXT_HTTP_ERROR_FALLBACK;404";
  return e;
}

function req(): Request {
  return new Request(
    "https://app.oxagen.sh/api/v1/mcp/oauth/authorize?orgSlug=acme&workspaceSlug=main&orgListingId=listing-1",
  );
}

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", publicId: "pub", name: "Acme", slug: "acme" };

beforeEach(() => {
  vi.clearAllMocks();
  mockProviderInstances.length = 0;
  mockGetSession.mockResolvedValue(SESSION);
  mockResolveOrg.mockResolvedValue(ORG);
  mockAssertMcpManager.mockResolvedValue(undefined);
});

describe("GET /api/v1/mcp/oauth/authorize — never crashes the function", () => {
  it("returns a handled 404 (not an unhandled throw) when assertMcpManager denies via notFound()", async () => {
    // Pre-fix: assertMcpManager's thrown notFound() escaped uncaught -> 502.
    mockAssertMcpManager.mockRejectedValueOnce(notFoundSentinel());

    // The promise must RESOLVE to a Response, never reject.
    const res = await GET(req() as never);

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: "not found or not permitted",
    });
  });

  it("returns a handled 404 when resolveOrg denies an unknown org slug via notFound()", async () => {
    mockResolveOrg.mockRejectedValueOnce(notFoundSentinel());

    const res = await GET(req() as never);

    expect(res.status).toBe(404);
  });

  it("returns a logged 500 (not a 502 crash) on an unexpected DB throw", async () => {
    // A real infra failure (e.g. connection refused) must become a clean 500,
    // distinct from the 404 auth-denial path.
    mockWithSystemDb.mockRejectedValueOnce(new Error("ECONNREFUSED 5432"));

    const res = await GET(req() as never);

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "internal error" });
  });

  it("returns 401 JSON when there is no session", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const res = await GET(req() as never);

    expect(res.status).toBe(401);
  });

  it("returns 400 JSON when required query params are missing", async () => {
    const res = await GET(
      new Request("https://app.oxagen.sh/api/v1/mcp/oauth/authorize") as never,
    );

    expect(res.status).toBe(400);
  });

  it("redirects to the authorization server on the success path", async () => {
    // listing lookup, then workspace lookup.
    mockWithSystemDb
      .mockResolvedValueOnce({
        id: "listing-1",
        orgId: ORG.id,
        endpointUrl: "https://mcp.example.com",
      })
      .mockResolvedValueOnce({ id: "ws-1" });
    // mcpAuth returns REDIRECT and populates the provider's pendingRedirect.
    mockMcpAuth.mockImplementationOnce(async () => {
      const inst = mockProviderInstances.at(-1);
      if (!inst) throw new Error("provider was not constructed");
      inst.pendingRedirect = new URL("https://auth.example.com/authorize?x=1");
      return "REDIRECT";
    });

    const res = await GET(req() as never);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://auth.example.com/authorize?x=1",
    );
  });
});
