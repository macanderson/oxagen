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
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen";
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

  const originalCidrs = process.env.TRUSTED_PROXY_CIDRS;

  /** The proxy list is memoized on first read, so set it and drop the cache. */
  function setTrustedProxyCidrs(cidrs: string): void {
    process.env.TRUSTED_PROXY_CIDRS = cidrs;
    __resetTrustedProxyHopsForTests();
  }

  beforeEach(() => {
    // Empty is the default, and a case that names proxies must not change how
    // the next one attributes an address.
    setTrustedProxyCidrs("");
  });

  afterEach(() => {
    if (originalCidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
    else process.env.TRUSTED_PROXY_CIDRS = originalCidrs;
    __resetTrustedProxyHopsForTests();
  });

  async function clientIpFor(
    headers: Record<string, string>,
  ): Promise<string | null> {
    const res = await withContext(headers, (c) => capabilityContext(c), scope);
    return ((await res.json()) as { clientIp: string | null }).clientIp;
  }

  // ── attribution ───────────────────────────────────────────────────────────

  it("returns the entry the trusted proxy wrote", async () => {
    setTrustedProxyCidrs("10.0.0.0/8");
    expect(
      await clientIpFor({ "x-forwarded-for": "203.0.113.7, 10.0.0.5" }),
    ).toBe("203.0.113.7");
  });

  it("walks past every trusted proxy, however many appended", async () => {
    setTrustedProxyCidrs("10.0.0.0/8, 172.16.0.0/12");
    expect(
      await clientIpFor({
        "x-forwarded-for": "203.0.113.7, 172.16.0.2, 10.0.0.5",
      }),
    ).toBe("203.0.113.7");
  });

  it("trims whitespace around the chosen entry", async () => {
    setTrustedProxyCidrs("10.0.0.0/8");
    expect(
      await clientIpFor({ "x-forwarded-for": "  203.0.113.7 ,  10.0.0.5  " }),
    ).toBe("203.0.113.7");
  });

  it("drops empty segments rather than mis-walking on a leading comma", async () => {
    setTrustedProxyCidrs("10.0.0.0/8");
    expect(
      await clientIpFor({ "x-forwarded-for": " , 203.0.113.7, 10.0.0.5" }),
    ).toBe("203.0.113.7");
  });

  // ── the bypasses this replaced a hop count to close ───────────────────────

  it("is unmoved by a caller padding the header", async () => {
    // Under a hop count this was the bypass: the caller controls the LENGTH, so
    // a count too high by k lands the arithmetic on an entry the caller wrote.
    // Here the walk stops on what an entry IS, so the prefix is never reached.
    setTrustedProxyCidrs("10.0.0.0/8");
    expect(
      await clientIpFor({
        "x-forwarded-for": "198.51.100.1, 10.9.9.9, 203.0.113.7, 10.0.0.5",
      }),
    ).toBe("203.0.113.7");
  });

  it("refuses a chain that never reaches a trusted proxy", async () => {
    // Nothing vouched for the rightmost entry, so it is whatever the caller
    // sent — a typo in the CIDR list, a network change, or a path that
    // bypasses the proxy all look like this.
    setTrustedProxyCidrs("10.0.0.0/8");
    expect(await clientIpFor({ "x-forwarded-for": "203.0.113.7" })).toBeNull();
    expect(
      await clientIpFor({ "x-forwarded-for": "10.0.0.5, 203.0.113.7" }),
    ).toBeNull();
  });

  it("refuses when every entry is a trusted proxy", async () => {
    setTrustedProxyCidrs("10.0.0.0/8");
    expect(
      await clientIpFor({ "x-forwarded-for": "10.0.0.4, 10.0.0.5" }),
    ).toBeNull();
  });

  // ── no proxies named: attribute nothing ───────────────────────────────────

  it("derives no address at all when no proxies are named", async () => {
    // The deployment has not said what stands in front of it, so nothing in
    // the request is vouched for. Returning the readable-but-unvouched-for
    // address is what made an IP allowlist judge the load balancer.
    expect(
      await clientIpFor({ "x-forwarded-for": "203.0.113.7, 10.0.0.5" }),
    ).toBeNull();
  });

  it("does not consult x-real-ip, which nothing can vouch for", async () => {
    setTrustedProxyCidrs("10.0.0.0/8");
    expect(await clientIpFor({ "x-real-ip": "203.0.113.7" })).toBeNull();
    expect(
      await clientIpFor({
        "x-real-ip": "203.0.113.7",
        "x-forwarded-for": "198.51.100.1",
      }),
    ).toBeNull();
  });

  it("returns null when no forwarding header is present", async () => {
    setTrustedProxyCidrs("10.0.0.0/8");
    expect(await clientIpFor({})).toBeNull();
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
    // too. The workspace id such a call carries is the org-only sentinel, not
    // the empty string: the kernel enters a tenant scope that asserts a uuid,
    // so an empty id was refused before the handler ran (#3029, ADR-068).
    const res = await withContext(
      {},
      (c) => capabilityContext(c, { requireWorkspace: false }),
      { orgId: "o1", workspaceId: null, userId: "u1", apiKeyId: null },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orgId: string; workspaceId: string };
    expect(body.orgId).toBe("o1");
    expect(body.workspaceId).toBe(ORG_ONLY_WORKSPACE_ID);
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

// ── INV-31: no surface builds a platform-operator binding ─────────────────────
//
// `set_org_billing_terms` is reachable only from a `CapabilityContext` carrying
// a binding minted by `createPlatformOperatorContext` (packages/oxagen). The
// kernel refuses any other value on that field, and the second half of the
// invariant is that no surface's context builder puts one there at all — not
// even `undefined`, which a later spread could overwrite unnoticed
// (apps/app/ARCHITECTURE.md §4, INV-31).

describe("capabilityContext and the platform-operator binding", () => {
  it("builds no platformOperator key at all", async () => {
    const res = await withContext(
      {},
      (c) => ({ hasKey: "platformOperator" in capabilityContext(c) }),
      { orgId: "o1", workspaceId: "w1", userId: "u1", apiKeyId: null },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasKey: boolean };
    expect(body.hasKey).toBe(false);
  });

  it("builds no platformOperator key on the bootstrap shape either", async () => {
    const res = await withContext(
      {},
      (c) => ({
        hasKey:
          "platformOperator" in capabilityContext(c, { requireOrg: false }),
      }),
      { orgId: null, workspaceId: null, userId: null, apiKeyId: null },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasKey: boolean };
    expect(body.hasKey).toBe(false);
  });
});
