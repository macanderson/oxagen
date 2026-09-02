import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";

// ---------------------------------------------------------------------------
// Generate a 2048-bit RSA test keypair once for the module.
// ---------------------------------------------------------------------------
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonBody = Record<string, unknown> | null;

function makeResponse(body: JsonBody, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeTokenResponse(token: string, expiresAt: string): Response {
  return makeResponse({ token, expires_at: expiresAt });
}

const FIXED_EXPIRES_AT = "2026-06-28T23:59:00Z";
const FIXED_EXPIRES_MS = Date.parse(FIXED_EXPIRES_AT);

// ---------------------------------------------------------------------------
// Import subject under test *after* declaring mocks so hoisting works.
// ---------------------------------------------------------------------------

import {
  createAppInstallationToken,
  getInstallationToken,
  __tokenCache,
} from "../app-auth";

// ---------------------------------------------------------------------------
// createAppInstallationToken
// ---------------------------------------------------------------------------

describe("createAppInstallationToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __tokenCache.clear();
  });

  it("builds a 3-part JWT and POSTs to the correct URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeTokenResponse("ghs_test_token", FIXED_EXPIRES_AT),
      );
    vi.stubGlobal("fetch", fetchMock);

    await createAppInstallationToken({
      appId: "12345",
      privateKey,
      installationId: 11111,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.github.com/app/installations/11111/access_tokens",
    );
    expect(init.method).toBe("POST");

    const authHeader =
      (init.headers as Record<string, string>)["Authorization"] ?? "";
    expect(authHeader).toMatch(/^Bearer /);
    const jwt = authHeader.slice("Bearer ".length);
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("returns { token, expiresAt } parsed from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(makeTokenResponse("ghs_abc", FIXED_EXPIRES_AT)),
    );

    const result = await createAppInstallationToken({
      appId: "99",
      privateKey,
      installationId: 11112,
    });

    expect(result.token).toBe("ghs_abc");
    expect(result.expiresAt).toBe(FIXED_EXPIRES_MS);
  });

  it("produces a valid RS256 JWT signature verifiable with the public key", async () => {
    const capturedJwts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const auth =
          (init.headers as Record<string, string>)["Authorization"] ?? "";
        capturedJwts.push(auth.slice("Bearer ".length));
        return Promise.resolve(
          makeTokenResponse("ghs_sig_test", FIXED_EXPIRES_AT),
        );
      }),
    );

    await createAppInstallationToken({
      appId: "999",
      privateKey,
      installationId: 11113,
    });

    const jwt = capturedJwts[0];
    expect(jwt).toBeDefined();
    const parts = jwt!.split(".");
    expect(parts).toHaveLength(3);
    const [header, payload, sig] = parts as [string, string, string];

    // Verify RS256 signature using the public key.
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    const valid = verifier.verify(publicKey, Buffer.from(sig, "base64url"));
    expect(valid).toBe(true);
  });

  it("includes correct JWT claims — iss, iat, exp", async () => {
    const fixedNow = 1_700_000_000_000; // ms
    const capturedJwts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const auth =
          (init.headers as Record<string, string>)["Authorization"] ?? "";
        capturedJwts.push(auth.slice("Bearer ".length));
        return Promise.resolve(
          makeTokenResponse("ghs_claims", FIXED_EXPIRES_AT),
        );
      }),
    );

    await createAppInstallationToken({
      appId: "APP42",
      privateKey,
      installationId: 11114,
      now: () => fixedNow,
    });

    const jwt = capturedJwts[0]!;
    const [, payloadB64] = jwt.split(".") as [string, string, string];
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    const nowSec = Math.floor(fixedNow / 1000);
    expect(payload["iss"]).toBe("APP42");
    expect(payload["iat"]).toBe(nowSec - 60);
    expect(payload["exp"]).toBe(nowSec + 540);
  });

  it("sends the required GitHub API headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeTokenResponse("ghs_hdr", FIXED_EXPIRES_AT));
    vi.stubGlobal("fetch", fetchMock);

    await createAppInstallationToken({
      appId: "1",
      privateKey,
      installationId: 11115,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("respects the baseUrl override", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeTokenResponse("ghs_base", FIXED_EXPIRES_AT));
    vi.stubGlobal("fetch", fetchMock);

    await createAppInstallationToken({
      appId: "1",
      privateKey,
      installationId: 11116,
      baseUrl: "https://ghes.example.com/api/v3",
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/ghes.example.com\/api\/v3\//);
  });

  it("throws with the GitHub error message on non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ message: "Not Found" }, 404)),
    );

    await expect(
      createAppInstallationToken({
        appId: "1",
        privateKey,
        installationId: 11117,
      }),
    ).rejects.toThrow("404");
  });

  it("normalises literal \\n in the private key string", async () => {
    // Build a version of the private key with literal \n escape sequences
    // (simulating a value pasted into an env var that lost real newlines).
    const literalEscaped = privateKey.replace(/\n/g, "\\n");

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          makeTokenResponse("ghs_escape", FIXED_EXPIRES_AT),
        ),
    );

    // Should not throw — the function normalises \\n → \n internally.
    await expect(
      createAppInstallationToken({
        appId: "1",
        privateKey: literalEscaped,
        installationId: 11118,
      }),
    ).resolves.toMatchObject({ token: "ghs_escape" });
  });
});

// ---------------------------------------------------------------------------
// getInstallationToken — caching behaviour
// ---------------------------------------------------------------------------

describe("getInstallationToken", () => {
  beforeEach(() => {
    __tokenCache.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __tokenCache.clear();
  });

  it("returns the token on first call", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          makeTokenResponse("ghs_first", FIXED_EXPIRES_AT),
        ),
    );

    const result = await getInstallationToken({
      appId: "app1",
      privateKey,
      installationId: 22221,
    });

    expect(result.token).toBe("ghs_first");
  });

  it("returns the cached token on the second call without making a second fetch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeTokenResponse("ghs_cached", FIXED_EXPIRES_AT));
    vi.stubGlobal("fetch", fetchMock);

    // First call — mints and caches.
    const first = await getInstallationToken({
      appId: "app1",
      privateKey,
      installationId: 22222,
      now: () => 1_000_000_000,
    });

    // Second call with same installationId — should reuse cache (no fetch).
    const second = await getInstallationToken({
      appId: "app1",
      privateKey,
      installationId: 22222,
      now: () => 1_000_001_000, // 1 second later, well within expiry
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(first.token).toBe("ghs_cached");
    expect(second.token).toBe("ghs_cached");
  });

  it("re-fetches when the cached token is within 60 s of expiry", async () => {
    const expiresAt = "2026-01-01T00:01:00Z";
    const expiresMs = Date.parse(expiresAt);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeTokenResponse("ghs_old", expiresAt))
      .mockResolvedValueOnce(makeTokenResponse("ghs_new", FIXED_EXPIRES_AT));
    vi.stubGlobal("fetch", fetchMock);

    // First call — mint and cache.
    await getInstallationToken({
      appId: "app1",
      privateKey,
      installationId: 22223,
      now: () => expiresMs - 120_000, // 2 min before expiry → freshly cached
    });

    // Second call — simulate clock at 30 s before expiry (within the 60 s buffer).
    const second = await getInstallationToken({
      appId: "app1",
      privateKey,
      installationId: 22223,
      now: () => expiresMs - 30_000, // 30 s before expiry → stale, should re-mint
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.token).toBe("ghs_new");
  });
});
