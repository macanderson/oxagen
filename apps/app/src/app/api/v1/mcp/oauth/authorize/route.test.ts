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
  mockResolveEndpoint,
  mockProviderInstances,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockAssertMcpManager: vi.fn(),
  mockWithSystemDb: vi.fn(),
  mockMcpAuth: vi.fn(),
  mockResolveEndpoint: vi.fn(),
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
    pluginInstalledPlugins: {
      id: "id",
      orgId: "orgId",
      endpointUrl: "endpointUrl",
    },
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
  resolveEndpointRedirects: mockResolveEndpoint,
}));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: mockMcpAuth,
}));

import { GET } from "./route";
// Resolves to the vi.mock'd constructor above — imported so the returnTo tests
// can assert what ctx the provider was constructed with.
import { DbOAuthClientProvider } from "@oxagen/plugins";

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
  // Default: the endpoint does not redirect (identity resolve).
  mockResolveEndpoint.mockImplementation(async (u: string) => u);
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

describe("GET /api/v1/mcp/oauth/authorize — user-facing failure routing", () => {
  /** Prime the listing + workspace lookups the happy path performs. */
  function primeHappyLookups(): void {
    mockWithSystemDb
      .mockResolvedValueOnce({
        id: "listing-1",
        orgId: ORG.id,
        endpointUrl: "https://mcp.example.com",
      })
      .mockResolvedValueOnce({ id: "ws-1" });
  }

  it("redirects back with reason=dcr_unsupported when the provider has no registration endpoint", async () => {
    // The GitHub case: mcpAuth dies in registerClient because the AS metadata
    // has no registration_endpoint. Pre-fix this surfaced as a raw JSON 502 on
    // a full-page navigation — a dead end for the user.
    primeHappyLookups();
    mockMcpAuth.mockRejectedValueOnce(
      new Error(
        "Incompatible auth server: does not support dynamic client registration",
      ),
    );

    const res = await GET(req() as never);

    expect(res.status).toBe(307);
    const dest = new URL(res.headers.get("location") ?? "");
    expect(dest.origin).toBe("https://app.oxagen.sh");
    expect(dest.pathname).toBe("/acme/main/workbench/tools/mcp");
    expect(dest.searchParams.get("mcp")).toBe("error");
    expect(dest.searchParams.get("listing")).toBe("listing-1");
    expect(dest.searchParams.get("reason")).toBe("dcr_unsupported");
  });

  it("redirects back with reason=provider_error on an unparseable provider response", async () => {
    primeHappyLookups();
    mockMcpAuth.mockRejectedValueOnce(
      new Error(
        'HTTP 401: Invalid OAuth error response: […]. Raw body: {"success":false}',
      ),
    );

    const res = await GET(req() as never);

    const dest = new URL(res.headers.get("location") ?? "");
    expect(dest.searchParams.get("mcp")).toBe("error");
    expect(dest.searchParams.get("reason")).toBe("provider_error");
  });

  it("redirects back with reason=auth_failed on any other mcpAuth failure", async () => {
    primeHappyLookups();
    mockMcpAuth.mockRejectedValueOnce(new Error("ETIMEDOUT"));

    const res = await GET(req() as never);

    const dest = new URL(res.headers.get("location") ?? "");
    expect(dest.searchParams.get("mcp")).toBe("error");
    expect(dest.searchParams.get("reason")).toBe("auth_failed");
  });

  it("redirects back with reason=no_redirect when mcpAuth returns REDIRECT without a URL", async () => {
    primeHappyLookups();
    mockMcpAuth.mockResolvedValueOnce("REDIRECT"); // pendingRedirect stays null

    const res = await GET(req() as never);

    expect(res.status).toBe(307);
    const dest = new URL(res.headers.get("location") ?? "");
    expect(dest.searchParams.get("mcp")).toBe("error");
    expect(dest.searchParams.get("reason")).toBe("no_redirect");
  });
});

describe("GET /api/v1/mcp/oauth/authorize — endpoint redirect self-heal", () => {
  it("resolves the endpoint's redirect chain, persists it, and authorizes against the real URL", async () => {
    // The inference.ac case: the registry published a vanity URL that 301s to
    // the real MCP endpoint on another host.
    mockWithSystemDb
      .mockResolvedValueOnce({
        id: "listing-1",
        orgId: ORG.id,
        endpointUrl: "https://sh.inference.ac",
      })
      .mockResolvedValueOnce({ id: "ws-1" })
      // Third call: the self-heal UPDATE of the listing's endpointUrl.
      .mockResolvedValueOnce(undefined);
    mockResolveEndpoint.mockResolvedValueOnce("https://api.inference.sh/mcp");
    mockMcpAuth.mockImplementationOnce(async () => {
      const inst = mockProviderInstances.at(-1);
      if (!inst) throw new Error("provider was not constructed");
      inst.pendingRedirect = new URL("https://auth.inference.sh/authorize");
      return "REDIRECT";
    });

    const res = await GET(req() as never);

    expect(res.status).toBe(307);
    // The provider and mcpAuth both see the RESOLVED endpoint.
    expect(vi.mocked(DbOAuthClientProvider)).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: "https://api.inference.sh/mcp" }),
    );
    expect(mockMcpAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serverUrl: "https://api.inference.sh/mcp" }),
    );
    // Listing lookup + workspace lookup + self-heal update.
    expect(mockWithSystemDb).toHaveBeenCalledTimes(3);
  });

  it("a failing self-heal write never blocks the flow", async () => {
    mockWithSystemDb
      .mockResolvedValueOnce({
        id: "listing-1",
        orgId: ORG.id,
        endpointUrl: "https://sh.inference.ac",
      })
      .mockResolvedValueOnce({ id: "ws-1" })
      .mockRejectedValueOnce(new Error("ECONNREFUSED 5432"));
    mockResolveEndpoint.mockResolvedValueOnce("https://api.inference.sh/mcp");
    mockMcpAuth.mockImplementationOnce(async () => {
      const inst = mockProviderInstances.at(-1);
      if (!inst) throw new Error("provider was not constructed");
      inst.pendingRedirect = new URL("https://auth.inference.sh/authorize");
      return "REDIRECT";
    });

    const res = await GET(req() as never);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://auth.inference.sh/authorize",
    );
  });
});

describe("GET /api/v1/mcp/oauth/authorize — returnTo validation", () => {
  function reqWithReturnTo(returnTo: string): Request {
    return new Request(
      "https://app.oxagen.sh/api/v1/mcp/oauth/authorize?orgSlug=acme&workspaceSlug=main&orgListingId=listing-1" +
        `&returnTo=${encodeURIComponent(returnTo)}`,
    );
  }

  /** Prime the listing + workspace lookups the happy path performs. */
  function primeHappyLookups(): void {
    mockWithSystemDb
      .mockResolvedValueOnce({
        id: "listing-1",
        orgId: ORG.id,
        endpointUrl: "https://mcp.example.com",
      })
      .mockResolvedValueOnce({ id: "ws-1" });
  }

  it("threads a valid same-org returnTo into the provider ctx and the already-authorized redirect", async () => {
    primeHappyLookups();
    mockMcpAuth.mockResolvedValueOnce("AUTHORIZED");

    const res = await GET(
      reqWithReturnTo("/acme/main/marketplace/agent-tools?tab=mcp") as never,
    );

    // The validated returnTo is what the provider persists into OAuth state
    // (it is what the callback redirects back to).
    expect(vi.mocked(DbOAuthClientProvider)).toHaveBeenCalledWith(
      expect.objectContaining({
        returnTo: "/acme/main/marketplace/agent-tools?tab=mcp",
      }),
    );

    // Already-authorized: redirect straight back to returnTo, preserving its
    // own query string and appending the flow-result params.
    expect(res.status).toBe(307);
    const dest = new URL(res.headers.get("location") ?? "");
    expect(dest.origin).toBe("https://app.oxagen.sh");
    expect(dest.pathname).toBe("/acme/main/marketplace/agent-tools");
    expect(dest.searchParams.get("tab")).toBe("mcp");
    expect(dest.searchParams.get("mcp")).toBe("already-connected");
    expect(dest.searchParams.get("listing")).toBe("listing-1");
  });

  it("falls back to the MCP Servers page when returnTo is an absolute URL (open-redirect guard)", async () => {
    primeHappyLookups();
    mockMcpAuth.mockResolvedValueOnce("AUTHORIZED");

    const res = await GET(reqWithReturnTo("https://evil.com/phish") as never);

    // The hostile value never reaches the provider ctx…
    expect(vi.mocked(DbOAuthClientProvider)).toHaveBeenCalledWith(
      expect.objectContaining({ returnTo: "/acme/main/workbench/tools/mcp" }),
    );

    // …and the redirect stays on our origin, on the default MCP Servers page.
    expect(res.status).toBe(307);
    const dest = new URL(res.headers.get("location") ?? "");
    expect(dest.origin).toBe("https://app.oxagen.sh");
    expect(dest.pathname).toBe("/acme/main/workbench/tools/mcp");
    expect(dest.searchParams.get("mcp")).toBe("already-connected");
    expect(dest.searchParams.get("listing")).toBe("listing-1");
  });
});
