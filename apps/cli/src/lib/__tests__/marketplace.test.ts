/**
 * Marketplace client tests — proves the browse/get/install calls map the
 * platform API responses into the stable MarketplaceClient shapes, send the
 * right request bodies to the right org-scoped paths, and degrade gracefully
 * (typed `{ ok: false }` results) on missing auth, HTTP errors, and network
 * failures rather than throwing. `fetch` is mocked; config + debug-log are
 * stubbed the same way lib/__tests__/api.test.ts does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mutable auth state so one file can exercise both logged-in and logged-out.
const authState = vi.hoisted(() => ({ token: "tok_test" as string }));
vi.mock("../config.js", () => ({
  getApiUrl: () => "https://api.oxagen.sh",
  getToken: () => authState.token,
  getOrgId: () => "org-slug",
  getWorkspaceId: () => "ws-slug",
}));
vi.mock("../debug-log.js", () => ({
  debugLog: vi.fn(() => Promise.resolve()),
  isDebugEnabled: () => false,
}));

import { createMarketplaceClient } from "../marketplace.js";

const originalFetch = globalThis.fetch;

/** Install a fetch mock returning `body` as JSON with `status`. Returns the spy. */
function mockFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const spy = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

/** Parse the JSON body of the Nth fetch call. */
function requestBody(
  spy: ReturnType<typeof vi.fn>,
  call = 0,
): Record<string, unknown> {
  const init = spy.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

beforeEach(() => {
  authState.token = "tok_test";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("MarketplaceClient.browseCatalog", () => {
  it("POSTs to the browse path and maps servers into entries", async () => {
    const spy = mockFetch({
      servers: [
        {
          id: "srv_1",
          name: "@acme/search",
          title: "Acme Search",
          description: "Search things",
          transportTypes: ["streamable-http"],
          authKind: "oauth",
          categories: ["search"],
          version: "1.2.0",
          pluginType: "mcp_server",
          installed: false,
        },
      ],
      nextOffset: 30,
      total: 41,
    });
    const client = createMarketplaceClient();
    const res = await client.browseCatalog({
      search: "acme",
      pluginType: "mcp_server",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const url = spy.mock.calls[0]?.[0] as string;
    expect(url).toBe(
      "https://api.oxagen.sh/v1/org-slug/ws-slug/plugin/catalog/browse",
    );
    expect(requestBody(spy)).toMatchObject({
      search: "acme",
      pluginType: "mcp_server",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.total).toBe(41);
    expect(res.data.nextOffset).toBe(30);
    expect(res.data.entries).toEqual([
      {
        id: "srv_1",
        name: "@acme/search",
        title: "Acme Search",
        description: "Search things",
        pluginType: "mcp_server",
        version: "1.2.0",
        installed: false,
        categories: ["search"],
      },
    ]);
  });

  it("passes through registry warnings", async () => {
    mockFetch({
      servers: [],
      nextOffset: null,
      total: 0,
      warnings: ["registry x timed out"],
    });
    const res = await createMarketplaceClient().browseCatalog();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.warnings).toEqual(["registry x timed out"]);
  });

  it("returns a typed auth failure when not logged in (no fetch)", async () => {
    authState.token = "";
    const spy = mockFetch({});
    const res = await createMarketplaceClient().browseCatalog();
    expect(spy).not.toHaveBeenCalled();
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("Not logged in"),
      code: "auth",
    });
  });

  it("maps an HTTP error to { ok:false, code:'http', status }", async () => {
    mockFetch("nope", 500);
    const res = await createMarketplaceClient().browseCatalog();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("http");
    expect(res.status).toBe(500);
  });

  it("maps a network failure to { ok:false, code:'network' }", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await createMarketplaceClient().browseCatalog();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("network");
    expect(res.error).toContain("ECONNREFUSED");
  });
});

describe("MarketplaceClient.getPlugin", () => {
  it("POSTs name + version and maps the detail fields", async () => {
    const spy = mockFetch({
      name: "@acme/search",
      title: "Acme Search",
      description: "Search things",
      version: "1.2.0",
      transportTypes: ["streamable-http"],
      authKind: "oauth",
      categories: ["search"],
      websiteUrl: "https://acme.example",
      readmeHtml: "<h1>Acme</h1>",
      // extra fields the client intentionally drops:
      packages: [{ x: 1 }],
      remotes: [],
    });
    const res = await createMarketplaceClient().getPlugin({
      name: "@acme/search",
      version: "1.2.0",
    });
    expect(requestBody(spy)).toEqual({
      name: "@acme/search",
      version: "1.2.0",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({
      name: "@acme/search",
      title: "Acme Search",
      description: "Search things",
      version: "1.2.0",
      transportTypes: ["streamable-http"],
      authKind: "oauth",
      categories: ["search"],
      websiteUrl: "https://acme.example",
      readmeHtml: "<h1>Acme</h1>",
    });
  });

  it("defaults version to 'latest' when omitted", async () => {
    const spy = mockFetch({
      name: "n",
      title: null,
      description: "",
      version: "9",
      transportTypes: [],
      authKind: "none",
      categories: [],
      websiteUrl: null,
    });
    await createMarketplaceClient().getPlugin({ name: "n" });
    expect(requestBody(spy)).toEqual({ name: "n", version: "latest" });
  });
});

describe("MarketplaceClient.installPlugin", () => {
  it("POSTs pluginType + pluginId (from the entry id) and maps the result", async () => {
    const spy = mockFetch({ orgListingId: "lst_9", authKind: "oauth" });
    const res = await createMarketplaceClient().installPlugin({
      pluginType: "mcp_server",
      id: "srv_1",
    });
    const url = spy.mock.calls[0]?.[0] as string;
    expect(url).toBe(
      "https://api.oxagen.sh/v1/org-slug/ws-slug/plugin/org/install",
    );
    expect(requestBody(spy)).toEqual({
      pluginType: "mcp_server",
      pluginId: "srv_1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ orgListingId: "lst_9", authKind: "oauth" });
  });

  it("returns a typed auth failure when not logged in", async () => {
    authState.token = "";
    const spy = mockFetch({});
    const res = await createMarketplaceClient().installPlugin({
      pluginType: "mcp_server",
      id: "x",
    });
    expect(spy).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("auth");
  });
});
