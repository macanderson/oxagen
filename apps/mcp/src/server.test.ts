/**
 * Unit tests for the MCP server dispatch path.
 *
 * The server derives its tool surface from the capability registry and routes
 * every POST /mcp/tools/:name through the kernel `invoke()` path. Tests cover:
 *
 *   1. capabilitiesForSurface("mcp") — /mcp/tools discovery returns every
 *      capability declared on the mcp surface.
 *   2. Successful invoke routing — valid body dispatched to the kernel and
 *      result wrapped in { result }.
 *   3. Error → HTTP mapping:
 *        unknown_capability  → 404
 *        surface_denied      → 403
 *        invalid_input       → 400
 *        no_handler          → 500
 *        invalid_output      → 500
 *        unexpected throw    → 500
 *   4. Malformed JSON body — treated as {} without crashing.
 *   5. /healthz — returns 200 { ok: true }.
 *
 * The @oxagen/oxagen module is mocked at the module seam. Tests do NOT touch
 * auth internals (that's OXA-1419's territory) or any DB path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @oxagen/oxagen — hoisted so all imports see the mock.
// ---------------------------------------------------------------------------

// vi.mock factories are hoisted to the top of the file by Vitest, so any
// local variables referenced inside the factory must also be hoisted via
// vi.hoisted() to avoid "Cannot access before initialization" errors.
const { CapabilityError, mockInvoke, mockCapabilitiesForSurface } = vi.hoisted(() => {
  class HoistedCapabilityError extends Error {
    constructor(
      readonly capability: string,
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "CapabilityError";
    }
  }
  return {
    CapabilityError: HoistedCapabilityError,
    mockInvoke: vi.fn(),
    mockCapabilitiesForSurface: vi.fn(),
  };
});

vi.mock("@oxagen/oxagen", () => ({
  CapabilityError,
  capabilitiesForSurface: mockCapabilitiesForSurface,
  invoke: mockInvoke,
}));

// Mock the side-effect register imports so they don't pull in heavy deps.
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));

// Import buildServer after mocks are set up.
import { buildServer } from "./server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp() {
  return buildServer();
}

function makeRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// /healthz
// ---------------------------------------------------------------------------

describe("GET /healthz", () => {
  it("returns 200 with ok: true", async () => {
    const app = makeApp();
    const res = await app.fetch(makeRequest("GET", "/healthz"));
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean };
    expect(json.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /mcp/tools — capability discovery
// ---------------------------------------------------------------------------

describe("GET /mcp/tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the capabilities exposed on the mcp surface", async () => {
    mockCapabilitiesForSurface.mockReturnValue([
      { name: "agent.list", description: "list agents", domain: "agent", mode: "sync" },
      { name: "org.create", description: "create org", domain: "org", mode: "sync" },
    ]);

    const app = makeApp();
    const res = await app.fetch(makeRequest("GET", "/mcp/tools"));
    expect(res.status).toBe(200);

    const body = await res.json() as { tools: { name: string }[] };
    expect(body.tools).toHaveLength(2);
    expect(body.tools.map((t) => t.name)).toEqual(["agent.list", "org.create"]);
  });

  it("passes 'mcp' as the surface argument to capabilitiesForSurface", async () => {
    mockCapabilitiesForSurface.mockReturnValue([]);
    const app = makeApp();
    await app.fetch(makeRequest("GET", "/mcp/tools"));
    expect(mockCapabilitiesForSurface).toHaveBeenCalledWith("mcp");
  });

  it("returns an empty tools array when no mcp capabilities are registered", async () => {
    mockCapabilitiesForSurface.mockReturnValue([]);
    const app = makeApp();
    const res = await app.fetch(makeRequest("GET", "/mcp/tools"));
    const body = await res.json() as { tools: unknown[] };
    expect(body.tools).toEqual([]);
  });

  it("includes name, description, domain, and mode in each tool entry", async () => {
    mockCapabilitiesForSurface.mockReturnValue([
      { name: "cap.foo", description: "Foo cap", domain: "foo", mode: "async" },
    ]);
    const app = makeApp();
    const res = await app.fetch(makeRequest("GET", "/mcp/tools"));
    const body = await res.json() as { tools: { name: string; description: string; domain: string; mode: string }[] };
    expect(body.tools[0]).toEqual({
      name: "cap.foo",
      description: "Foo cap",
      domain: "foo",
      mode: "async",
    });
  });
});

// ---------------------------------------------------------------------------
// POST /mcp/tools/:name — successful dispatch
// ---------------------------------------------------------------------------

describe("POST /mcp/tools/:name — successful dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with result wrapped in { result }", async () => {
    mockInvoke.mockResolvedValueOnce({ items: ["a", "b"] });
    const app = makeApp();
    const res = await app.fetch(makeRequest("POST", "/mcp/tools/agent.list", { limit: 10 }));
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { items: string[] } };
    expect(body.result).toEqual({ items: ["a", "b"] });
  });

  it("passes the capability name, body, and surface:mcp to invoke", async () => {
    mockInvoke.mockResolvedValueOnce({});
    const app = makeApp();
    await app.fetch(makeRequest("POST", "/mcp/tools/org.create", { name: "Acme" }));

    expect(mockInvoke).toHaveBeenCalledOnce();
    const [name, body, _ctx, opts] = mockInvoke.mock.calls[0] as [string, unknown, unknown, { surface: string }];
    expect(name).toBe("org.create");
    expect(body).toEqual({ name: "Acme" });
    expect(opts.surface).toBe("mcp");
  });

  it("passes an empty object body when POST body is empty JSON", async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true });
    const app = makeApp();
    const req = new Request("http://localhost/mcp/tools/cap.name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await app.fetch(req);
    const [_name, body] = mockInvoke.mock.calls[0] as [string, unknown];
    expect(body).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// POST /mcp/tools/:name — error → HTTP status mapping
// ---------------------------------------------------------------------------

describe("POST /mcp/tools/:name — CapabilityError mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps unknown_capability to 404", async () => {
    mockInvoke.mockRejectedValueOnce(
      new CapabilityError("cap.missing", "unknown_capability", "Unknown"),
    );
    const app = makeApp();
    const res = await app.fetch(makeRequest("POST", "/mcp/tools/cap.missing", {}));
    expect(res.status).toBe(404);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("unknown_capability");
  });

  it("maps surface_denied to 403", async () => {
    mockInvoke.mockRejectedValueOnce(
      new CapabilityError("cap.agent_only", "surface_denied", "Denied"),
    );
    const app = makeApp();
    const res = await app.fetch(makeRequest("POST", "/mcp/tools/cap.agent_only", {}));
    expect(res.status).toBe(403);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("surface_denied");
  });

  it("maps invalid_input to 400", async () => {
    mockInvoke.mockRejectedValueOnce(
      new CapabilityError("cap.foo", "invalid_input", "Bad input"),
    );
    const app = makeApp();
    const res = await app.fetch(makeRequest("POST", "/mcp/tools/cap.foo", {}));
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("invalid_input");
  });

  it("maps no_handler to 500", async () => {
    mockInvoke.mockRejectedValueOnce(
      new CapabilityError("cap.bar", "no_handler", "No handler"),
    );
    const app = makeApp();
    const res = await app.fetch(makeRequest("POST", "/mcp/tools/cap.bar", {}));
    expect(res.status).toBe(500);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("no_handler");
  });

  it("maps invalid_output to 500", async () => {
    mockInvoke.mockRejectedValueOnce(
      new CapabilityError("cap.baz", "invalid_output", "Bad output"),
    );
    const app = makeApp();
    const res = await app.fetch(makeRequest("POST", "/mcp/tools/cap.baz", {}));
    expect(res.status).toBe(500);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("invalid_output");
  });

  it("returns error message in the body for CapabilityError", async () => {
    mockInvoke.mockRejectedValueOnce(
      new CapabilityError("cap.foo", "unknown_capability", "Unknown capability cap.foo"),
    );
    const app = makeApp();
    const res = await app.fetch(makeRequest("POST", "/mcp/tools/cap.foo", {}));
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Unknown capability cap.foo");
  });
});

// ---------------------------------------------------------------------------
// POST /mcp/tools/:name — unexpected (non-CapabilityError) throws
// ---------------------------------------------------------------------------

describe("POST /mcp/tools/:name — unexpected errors", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 500 for an unexpected Error thrown by invoke", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("database exploded"));
    const app = makeApp();
    const res = await app.fetch(makeRequest("POST", "/mcp/tools/cap.boom", {}));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("database exploded");
  });

  it("returns 500 and stringifies non-Error throws", async () => {
    mockInvoke.mockRejectedValueOnce("raw string error");
    const app = makeApp();
    const res = await app.fetch(makeRequest("POST", "/mcp/tools/cap.boom", {}));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON body
// ---------------------------------------------------------------------------

describe("POST /mcp/tools/:name — malformed JSON body", () => {
  beforeEach(() => vi.clearAllMocks());

  it("falls back to an empty object when the body is not valid JSON", async () => {
    mockInvoke.mockResolvedValueOnce({});
    const app = makeApp();
    const req = new Request("http://localhost/mcp/tools/cap.foo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "NOT_JSON",
    });
    // Should not throw — the .catch(() => ({})) in server.ts handles this.
    const res = await app.fetch(req);
    // The request reaches invoke (with {}).
    expect(mockInvoke).toHaveBeenCalledOnce();
    const [_name, body] = mockInvoke.mock.calls[0] as [string, unknown];
    expect(body).toEqual({});
    expect(res.status).toBe(200);
  });
});
