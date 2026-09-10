/**
 * Unit tests for src/lib/context.ts
 *
 * Covers:
 * - extractClientIp: which x-forwarded-for hop is taken for a given
 *   TRUSTED_PROXY_HOP_COUNT, that a caller-supplied prefix cannot move it,
 *   x-real-ip fallback, and both absent → null
 * - capabilityContext: requireOrg default true throws 400 when orgId or workspaceId null,
 *   requireOrg false does not throw, requestId fallback is UUID-shaped
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

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
import {
  capabilityContext,
  __resetTrustedProxyHopsForTests,
} from "../lib/context";
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
// extractClientIp is exported, but going through capabilityContext is what
// proves the value actually reaches CapabilityContext.clientIp — which is what
// the IAM ip_ranges / ip_allow conditions evaluate.
//
// Each proxy APPENDS the address it received the request from, so the entries a
// caller sent itself sit on the LEFT and the trusted proxies' own writes on the
// right. These cases pin that arithmetic: reading the leftmost hop let a caller
// put an allowlisted address in the header and satisfy an IP allowlist.

describe("extractClientIp (via capabilityContext.clientIp)", () => {
  const scope = {
    orgId: "o1",
    workspaceId: "w1",
    userId: null,
    apiKeyId: null,
  };

  const originalHopCount = process.env.TRUSTED_PROXY_HOP_COUNT;

  /** The hop count is memoized on first read, so set it and drop the cache. */
  function setTrustedProxyHops(count: string): void {
    process.env.TRUSTED_PROXY_HOP_COUNT = count;
    __resetTrustedProxyHopsForTests();
  }

  beforeEach(() => {
    setTrustedProxyHops("1");
  });

  afterEach(() => {
    if (originalHopCount === undefined)
      delete process.env.TRUSTED_PROXY_HOP_COUNT;
    else process.env.TRUSTED_PROXY_HOP_COUNT = originalHopCount;
    __resetTrustedProxyHopsForTests();
  });

  async function clientIpFor(
    headers: Record<string, string>,
  ): Promise<string | null> {
    const res = await withContext(headers, (c) => capabilityContext(c), scope);
    return ((await res.json()) as { clientIp: string | null }).clientIp;
  }

  it("returns the single entry a one-hop proxy wrote", async () => {
    expect(await clientIpFor({ "x-forwarded-for": "10.0.0.1" })).toBe(
      "10.0.0.1",
    );
  });

  it("takes the rightmost hop, not the caller-supplied leftmost one", async () => {
    // The bypass: everything left of the trusted proxy's own write is a string
    // the caller chose.
    expect(
      await clientIpFor({
        "x-forwarded-for": "10.0.0.1, 172.16.0.2, 192.168.0.3",
      }),
    ).toBe("192.168.0.3");
  });

  it("trims whitespace around the chosen hop", async () => {
    expect(
      await clientIpFor({ "x-forwarded-for": "  10.0.0.1  ,  172.16.0.2  " }),
    ).toBe("172.16.0.2");
  });

  it("skips the extra proxy's own address when two hops are trusted", async () => {
    // CDN → ALB → app: the CDN appends the client, the ALB appends the CDN.
    setTrustedProxyHops("2");
    expect(
      await clientIpFor({ "x-forwarded-for": "203.0.113.7, 192.0.2.44" }),
    ).toBe("203.0.113.7");
  });

  it("a longer spoofed prefix cannot move the chosen hop", async () => {
    setTrustedProxyHops("2");
    expect(
      await clientIpFor({
        "x-forwarded-for": "10.0.0.1, 10.0.0.2, 203.0.113.7, 192.0.2.44",
      }),
    ).toBe("203.0.113.7");
  });

  it("ignores x-forwarded-for entirely when no proxy is trusted", async () => {
    // Nothing in front rewrote the header, so every entry is caller-supplied.
    setTrustedProxyHops("0");
    expect(
      await clientIpFor({ "x-forwarded-for": "10.0.0.1, 192.168.0.3" }),
    ).toBeNull();
  });

  it("falls back to the leftmost entry when the chain is shorter than the count", async () => {
    // A proxy did not append what this deployment says it does; the oldest
    // entry is the best candidate left, and better than nothing.
    setTrustedProxyHops("3");
    expect(
      await clientIpFor({ "x-forwarded-for": "203.0.113.7, 192.0.2.44" }),
    ).toBe("203.0.113.7");
  });

  it("drops empty segments rather than falling through on a leading comma", async () => {
    expect(
      await clientIpFor({
        "x-forwarded-for": " , 10.0.0.2",
        "x-real-ip": "5.5.5.5",
      }),
    ).toBe("10.0.0.2");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    expect(await clientIpFor({ "x-real-ip": "1.2.3.4" })).toBe("1.2.3.4");
  });

  it("returns null when both headers are absent", async () => {
    expect(await clientIpFor({})).toBeNull();
  });

  it("returns null when x-real-ip is empty and x-forwarded-for is absent", async () => {
    expect(await clientIpFor({ "x-real-ip": "" })).toBeNull();
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

  it("requires an org but not a workspace when requireWorkspace is false (#1203)", async () => {
    // The shape a bootstrap route needs: the caller has an org and is asking
    // for their first workspace. Before this existed the only way to get past
    // the workspace check was requireOrg:false, which dropped the org check
    // too.
    const res = await withContext(
      {},
      (c) => capabilityContext(c, { requireWorkspace: false }),
      { orgId: "o1", workspaceId: null, userId: "u1", apiKeyId: null },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orgId: string; workspaceId: string };
    expect(body.orgId).toBe("o1");
    expect(body.workspaceId).toBe("");
  });

  it("still refuses a missing org when only the workspace check is waived", async () => {
    const res = await withContext(
      {},
      (c) => capabilityContext(c, { requireWorkspace: false }),
      { orgId: null, workspaceId: null, userId: "u1", apiKeyId: null },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("scope");
  });

  it("keeps requireOrg:false switching off both checks, as its callers rely on", async () => {
    const res = await withContext(
      {},
      (c) => capabilityContext(c, { requireOrg: false }),
      { orgId: null, workspaceId: null, userId: null, apiKeyId: null },
    );
    expect(res.status).toBe(200);
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
