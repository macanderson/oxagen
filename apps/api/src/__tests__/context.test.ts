/**
 * Unit tests for src/lib/context.ts
 *
 * Covers:
 * - extractClientIp: single XFF, comma-list returns leftmost, trims,
 *   x-real-ip fallback, both absent → null, empty first segment
 * - capabilityContext: requireOrg default true throws 400 when orgId or workspaceId null,
 *   requireOrg false does not throw, requestId fallback is UUID-shaped
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: vi.fn(),
  clearHandlersForTests: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    verifyStripeSignature: vi.fn(),
    processStripeEvent: vi.fn(),
    bootstrapBillingRuntime: vi.fn(),
  };
});

vi.mock("@oxagen/handlers", () => ({
  serveFile: vi.fn(),
  FileNotFoundError: class FileNotFoundError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileNotFoundError";
    }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileForbiddenError";
    }
  },
}));

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { capabilityContext } from "../lib/context";
import type { AppEnv } from "../app";
import { UUID_RE } from "./_helpers";

/**
 * Build a tiny Hono app that runs `fn(c)` in a GET / handler,
 * then fetch it with the given headers and return the Response.
 */
async function withContext(
  headers: Record<string, string>,
  handler: (c: import("hono").Context<AppEnv>) => unknown,
  contextVars?: Partial<AppEnv["Variables"]>,
): Promise<Response> {
  const app = new Hono<AppEnv>();

  // Set context variables before the handler
  app.use("*", async (c, next) => {
    if (contextVars?.orgId !== undefined) c.set("orgId", contextVars.orgId);
    if (contextVars?.workspaceId !== undefined)
      c.set("workspaceId", contextVars.workspaceId);
    if (contextVars?.userId !== undefined) c.set("userId", contextVars.userId);
    if (contextVars?.apiKeyId !== undefined)
      c.set("apiKeyId", contextVars.apiKeyId);
    if (contextVars?.requestId !== undefined)
      c.set("requestId", contextVars.requestId);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message, status: err.status }, err.status);
    }
    return c.json({ error: "internal" }, 500);
  });

  app.get("/", (c) => {
    const result = handler(c);
    return c.json(result);
  });

  const req = new Request("http://localhost/", { headers });
  return app.fetch(req);
}

// ── extractClientIp via capabilityContext ─────────────────────────────────────
// extractClientIp is not exported, so we test it indirectly via the returned
// capabilityContext.clientIp.

describe("extractClientIp (via capabilityContext.clientIp)", () => {
  const scope = {
    orgId: "o1",
    workspaceId: "w1",
    userId: null,
    apiKeyId: null,
  };

  it("returns the leftmost IP from a single XFF header", async () => {
    const res = await withContext(
      { "x-forwarded-for": "10.0.0.1" },
      (c) => capabilityContext(c),
      scope,
    );
    const body = (await res.json()) as { clientIp: string | null };
    expect(body.clientIp).toBe("10.0.0.1");
  });

  it("returns only the leftmost IP when XFF has a comma-separated list", async () => {
    const res = await withContext(
      { "x-forwarded-for": "10.0.0.1, 172.16.0.2, 192.168.0.3" },
      (c) => capabilityContext(c),
      scope,
    );
    const body = (await res.json()) as { clientIp: string | null };
    expect(body.clientIp).toBe("10.0.0.1");
  });

  it("trims whitespace from the extracted IP", async () => {
    const res = await withContext(
      { "x-forwarded-for": "  10.0.0.1  , 172.16.0.2" },
      (c) => capabilityContext(c),
      scope,
    );
    const body = (await res.json()) as { clientIp: string | null };
    expect(body.clientIp).toBe("10.0.0.1");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    const res = await withContext(
      { "x-real-ip": "1.2.3.4" },
      (c) => capabilityContext(c),
      scope,
    );
    const body = (await res.json()) as { clientIp: string | null };
    expect(body.clientIp).toBe("1.2.3.4");
  });

  it("returns null when both headers are absent", async () => {
    const res = await withContext({}, (c) => capabilityContext(c), scope);
    const body = (await res.json()) as { clientIp: string | null };
    expect(body.clientIp).toBeNull();
  });

  it("returns null when x-real-ip is empty and x-forwarded-for is absent", async () => {
    const res = await withContext(
      { "x-real-ip": "" },
      (c) => capabilityContext(c),
      scope,
    );
    const body = (await res.json()) as { clientIp: string | null };
    expect(body.clientIp).toBeNull();
  });

  it("skips empty first segment and falls back to x-real-ip (XFF leading comma)", async () => {
    // When the first segment is empty (e.g. ",10.0.0.2"), trim() returns "" which
    // is falsy — the code falls through to x-real-ip.
    const res = await withContext(
      { "x-forwarded-for": " , 10.0.0.2", "x-real-ip": "5.5.5.5" },
      (c) => capabilityContext(c),
      scope,
    );
    const body = (await res.json()) as { clientIp: string | null };
    // Per source: `if (first && first.length > 0) return first;` — empty → fallback
    expect(body.clientIp).toBe("5.5.5.5");
  });
});

// ── capabilityContext: requireOrg behaviour ───────────────────────────────────

describe("capabilityContext requireOrg", () => {
  it("throws 400 when orgId is null and requireOrg is default (true)", async () => {
    const res = await withContext(
      {},
      (c) => capabilityContext(c), // default requireOrg = true
      { orgId: null, workspaceId: "w1", userId: null, apiKeyId: null },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("scope");
  });

  it("throws 400 when workspaceId is null and requireOrg is default (true)", async () => {
    const res = await withContext({}, (c) => capabilityContext(c), {
      orgId: "o1",
      workspaceId: null,
      userId: null,
      apiKeyId: null,
    });
    expect(res.status).toBe(400);
  });

  it("does NOT throw when requireOrg is false and orgId is null", async () => {
    const res = await withContext(
      {},
      (c) => capabilityContext(c, { requireOrg: false }),
      { orgId: null, workspaceId: null, userId: null, apiKeyId: null },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orgId: string };
    // orgId falls back to empty string per source: `orgId: orgId ?? ""`
    expect(body.orgId).toBe("");
  });

  it("surface is always 'api'", async () => {
    const res = await withContext({}, (c) => capabilityContext(c), {
      orgId: "o1",
      workspaceId: "w1",
      userId: null,
      apiKeyId: null,
    });
    const body = (await res.json()) as { surface: string };
    expect(body.surface).toBe("api");
  });

  it("requestId falls back to a UUID when not set in context", async () => {
    const res = await withContext(
      {},
      (c) => capabilityContext(c),
      { orgId: "o1", workspaceId: "w1", userId: null, apiKeyId: null },
      // Note: requestId NOT set in contextVars — falls back to crypto.randomUUID()
    );
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId.length).toBeGreaterThan(0);
    // UUID shape — crypto.randomUUID() always produces a v4 UUID
    expect(UUID_RE.test(body.requestId)).toBe(true);
  });

  it("requestId uses context value when set", async () => {
    const fixedId = "a1b2c3d4-e5f6-4abc-8def-000000000001";
    const res = await withContext({}, (c) => capabilityContext(c), {
      orgId: "o1",
      workspaceId: "w1",
      userId: null,
      apiKeyId: null,
      requestId: fixedId,
    });
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe(fixedId);
  });

  it("messageId is always null", async () => {
    const res = await withContext({}, (c) => capabilityContext(c), {
      orgId: "o1",
      workspaceId: "w1",
      userId: null,
      apiKeyId: null,
    });
    const body = (await res.json()) as { messageId: null };
    expect(body.messageId).toBeNull();
  });

  it("userId comes from context variable (null for api-key auth)", async () => {
    const res = await withContext({}, (c) => capabilityContext(c), {
      orgId: "o1",
      workspaceId: "w1",
      userId: null,
      apiKeyId: "k1",
    });
    const body = (await res.json()) as { userId: string | null };
    expect(body.userId).toBeNull();
  });

  it("userId comes from context variable (set for session auth)", async () => {
    const res = await withContext({}, (c) => capabilityContext(c), {
      orgId: "o1",
      workspaceId: "w1",
      userId: "user-123",
      apiKeyId: null,
    });
    const body = (await res.json()) as { userId: string };
    expect(body.userId).toBe("user-123");
  });
});
