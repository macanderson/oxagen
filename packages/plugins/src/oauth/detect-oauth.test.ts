/**
 * detect-oauth.test.ts — unit tests for the OAuth 2.1 protection probe.
 *
 * detectOAuthProtected() is exercised exclusively through its fetchFn
 * injection seam — no test performs real network I/O. Contract under test:
 * RFC 9728 well-known metadata naming ≥1 authorization server → true;
 * otherwise an unauthenticated MCP initialize answered with 401 → true; every
 * failure mode (404s, bad JSON, network errors, non-http URLs) → false, and
 * the probe NEVER throws.
 */
import { describe, expect, it, vi } from "vitest";
import { detectOAuthProtected, wellKnownCandidates } from "./detect-oauth";

// ── Test fetch harness ────────────────────────────────────────────────────────

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
}

type FetchInput = Parameters<typeof fetch>[0];

/** Builds an injectable fetch that records every call and delegates to `impl`. */
function makeFetch(
  impl: (url: string, init: RequestInit | undefined) => Promise<Response>,
) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(
    async (input: FetchInput, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return impl(url, init);
    },
  );
  return { fetchFn: fn as unknown as typeof fetch, calls, mock: fn };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROTECTED_METADATA = {
  resource: "https://mcp.stripe.com",
  authorization_servers: ["https://as.stripe.com"],
};

// ── wellKnownCandidates ───────────────────────────────────────────────────────

describe("wellKnownCandidates", () => {
  it("yields a single root candidate for an origin-root endpoint", () => {
    expect(wellKnownCandidates("https://mcp.stripe.com")).toEqual([
      "https://mcp.stripe.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("yields the path-aware candidate first, then the root, for a pathed endpoint", () => {
    expect(wellKnownCandidates("https://x.com/mcp")).toEqual([
      "https://x.com/.well-known/oauth-protected-resource/mcp",
      "https://x.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("normalises a trailing slash on the resource path", () => {
    expect(wellKnownCandidates("https://x.com/mcp/")).toEqual([
      "https://x.com/.well-known/oauth-protected-resource/mcp",
      "https://x.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("treats a bare trailing-slash origin as the root candidate only", () => {
    expect(wellKnownCandidates("https://x.com/")).toEqual([
      "https://x.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("preserves multi-segment resource paths in the path-aware candidate", () => {
    expect(wellKnownCandidates("https://x.com/tenants/acme/mcp")).toEqual([
      "https://x.com/.well-known/oauth-protected-resource/tenants/acme/mcp",
      "https://x.com/.well-known/oauth-protected-resource",
    ]);
  });
});

// ── detectOAuthProtected ──────────────────────────────────────────────────────

describe("detectOAuthProtected", () => {
  it("returns true on well-known 200 with authorization_servers — and never issues the POST probe", async () => {
    const { fetchFn, calls } = makeFetch(async () =>
      jsonResponse(200, PROTECTED_METADATA),
    );

    await expect(
      detectOAuthProtected("https://mcp.stripe.com", { fetchFn }),
    ).resolves.toBe(true);

    // Exactly one call: the root well-known GET. No unauthenticated initialize.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://mcp.stripe.com/.well-known/oauth-protected-resource",
      method: "GET",
    });
  });

  it("stops at the first (path-aware) candidate when it is definitive", async () => {
    const { fetchFn, calls } = makeFetch(async () =>
      jsonResponse(200, PROTECTED_METADATA),
    );

    await expect(
      detectOAuthProtected("https://x.com/mcp", { fetchFn }),
    ).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://x.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("returns false when well-known 200 lacks authorization_servers and the POST probe gets 200", async () => {
    const { fetchFn, calls } = makeFetch(async (_url, init) =>
      init?.method === "POST"
        ? jsonResponse(200, { jsonrpc: "2.0", id: 0, result: {} })
        : jsonResponse(200, {}),
    );

    await expect(
      detectOAuthProtected("https://mcp.stripe.com", { fetchFn }),
    ).resolves.toBe(false);

    // Metadata without an AS is not definitive — the POST fallback must run,
    // as an unauthenticated MCP initialize against the endpoint itself.
    const post = calls.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    expect(post!.url).toBe("https://mcp.stripe.com");
    expect(post!.body).toContain('"method":"initialize"');
  });

  it("treats an empty authorization_servers array as not definitive (POST 200 → false)", async () => {
    const { fetchFn } = makeFetch(async (_url, init) =>
      init?.method === "POST"
        ? new Response("ok", { status: 200 })
        : jsonResponse(200, {
            resource: "https://x.com/mcp",
            authorization_servers: [],
          }),
    );

    await expect(
      detectOAuthProtected("https://x.com/mcp", { fetchFn }),
    ).resolves.toBe(false);
  });

  it("returns true when both well-known candidates 404 but the POST probe gets 401", async () => {
    const { fetchFn, calls } = makeFetch(async (_url, init) =>
      init?.method === "POST"
        ? new Response("Unauthorized", { status: 401 })
        : new Response("Not Found", { status: 404 }),
    );

    await expect(
      detectOAuthProtected("https://x.com/mcp", { fetchFn }),
    ).resolves.toBe(true);

    // Both candidates probed (path-aware then root), then the 401 challenge.
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
    expect(calls[2]!.url).toBe("https://x.com/mcp");
  });

  it("returns false when well-known 404s and the POST probe gets 200", async () => {
    const { fetchFn } = makeFetch(async (_url, init) =>
      init?.method === "POST"
        ? new Response("ok", { status: 200 })
        : new Response("Not Found", { status: 404 }),
    );

    await expect(
      detectOAuthProtected("https://mcp.stripe.com", { fetchFn }),
    ).resolves.toBe(false);
  });

  it("survives a well-known 200 with a non-JSON body and still runs the 401 fallback", async () => {
    const { fetchFn } = makeFetch(async (_url, init) =>
      init?.method === "POST"
        ? new Response(null, { status: 401 })
        : new Response("<html>not json</html>", { status: 200 }),
    );

    await expect(
      detectOAuthProtected("https://x.com/mcp", { fetchFn }),
    ).resolves.toBe(true);
  });

  it("returns false (never throws) when fetch rejects everywhere", async () => {
    const { fetchFn, calls } = makeFetch(async () => {
      throw new Error("network down / timeout");
    });

    await expect(
      detectOAuthProtected("https://x.com/mcp", { fetchFn }),
    ).resolves.toBe(false);

    // Every probe was attempted despite the failures: 2 candidates + 1 POST.
    expect(calls).toHaveLength(3);
  });

  it("returns false for a non-http(s) URL without calling fetch", async () => {
    const { fetchFn, mock } = makeFetch(async () => {
      throw new Error("must not be called");
    });

    await expect(detectOAuthProtected("stdio://x", { fetchFn })).resolves.toBe(
      false,
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("returns false for an unparseable URL without calling fetch", async () => {
    const { fetchFn, mock } = makeFetch(async () => {
      throw new Error("must not be called");
    });

    await expect(detectOAuthProtected("not a url", { fetchFn })).resolves.toBe(
      false,
    );
    expect(mock).not.toHaveBeenCalled();
  });
});
