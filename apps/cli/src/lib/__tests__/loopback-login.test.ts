/**
 * Unit tests for lib/loopback-login.ts.
 *
 * Strategy: let the real http.createServer bind to an ephemeral port (no
 * mocking of node:http needed — a real loopback server is fast and avoids
 * mock complexity). Mock `open-browser` to capture the authorize URL (which
 * carries the port via the redirect_uri param), then fire real HTTP requests
 * at that port to simulate the browser callback.
 *
 * `fetch` is stubbed globally so no real network calls are made.
 *
 * Covered cases:
 *   1. Successful round-trip → returns { token, orgSlug, workspaceSlug }
 *      and POSTs the correct body (code, code_verifier, redirect_uri).
 *   2. State mismatch in callback → rejects "state mismatch (possible CSRF)".
 *   3. `error` query param in callback → rejects with that error string.
 *   4. Non-200 token exchange → rejects with the server's error_description.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as http from "node:http";

// Mock open-browser BEFORE importing browserLogin so the module resolver sees
// the stub when loopback-login.ts imports open-browser.js.
vi.mock("../open-browser", () => ({
  openBrowser: vi.fn(),
}));

import { browserLogin } from "../loopback-login";
import { openBrowser } from "../open-browser";

const mockOpenBrowser = vi.mocked(openBrowser);

// Stub the global fetch so no real HTTP calls leave the test.
// Untyped vi.fn() avoids pulling in DOM-only types (RequestInfo, etc.).
// Call-argument shapes are accessed via `as unknown as` casts where needed.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── helpers ────────────────────────────────────────────────────────────────────

/** Poll until `check` stops throwing, or throw after `timeoutMs`. */
async function waitFor(check: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      check();
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error("waitFor timed out");
      await new Promise<void>((r) => setTimeout(r, 15));
    }
  }
}

/** Extract the loopback port from the authorize URL captured by openBrowser. */
function portFromAuthorizeUrl(authorizeUrl: string): number {
  const redirectUri = new URL(authorizeUrl).searchParams.get("redirect_uri");
  if (!redirectUri) throw new Error("redirect_uri missing from authorize URL");
  return parseInt(new URL(redirectUri).port, 10);
}

/** Extract the state param from the authorize URL. */
function stateFromAuthorizeUrl(authorizeUrl: string): string {
  const s = new URL(authorizeUrl).searchParams.get("state");
  if (!s) throw new Error("state missing from authorize URL");
  return s;
}

/** Extract the redirect_uri param from the authorize URL. */
function redirectUriFromAuthorizeUrl(authorizeUrl: string): string {
  const r = new URL(authorizeUrl).searchParams.get("redirect_uri");
  if (!r) throw new Error("redirect_uri missing from authorize URL");
  return r;
}

/** Send a GET request to the loopback server and wait for the response to end. */
function sendCallback(port: number, query: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/callback?${query}`,
        method: "GET",
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe("browserLogin", () => {
  beforeEach(() => {
    mockOpenBrowser.mockReset();
    mockFetch.mockReset();
  });

  it("successful round-trip: returns token+slugs and POSTs the correct body", async () => {
    const expectedToken = "tok_test_abc123";
    const expectedOrg = "acme";
    const expectedWs = "main";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        token: expectedToken,
        orgSlug: expectedOrg,
        workspaceSlug: expectedWs,
      }),
    } as Response);

    const loginPromise = browserLogin({
      apiUrl: "https://api.test.oxagen.sh",
      appUrl: "https://app.test.oxagen.sh",
    });

    // Wait for the server to be listening (openBrowser is called immediately after).
    await waitFor(() => expect(mockOpenBrowser).toHaveBeenCalledOnce());

    // Non-null assertions below are safe: waitFor() confirmed openBrowser was called.
    const authorizeUrl = mockOpenBrowser.mock.calls[0]![0];
    const port = portFromAuthorizeUrl(authorizeUrl);
    const state = stateFromAuthorizeUrl(authorizeUrl);
    const redirectUri = redirectUriFromAuthorizeUrl(authorizeUrl);

    const query = new URLSearchParams({ code: "authcode_xyz", state }).toString();
    await sendCallback(port, query);

    const result = await loginPromise;
    expect(result).toEqual({
      token: expectedToken,
      orgSlug: expectedOrg,
      workspaceSlug: expectedWs,
    });

    // Verify the token exchange POST
    expect(mockFetch).toHaveBeenCalledOnce();
    // Cast through unknown — toHaveBeenCalledOnce() guarantees calls[0] exists.
    const [fetchUrl, fetchInit] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(fetchUrl).toBe("https://api.test.oxagen.sh/v1/auth/cli/token");
    expect(fetchInit.method).toBe("POST");

    const rawBody = fetchInit.body;
    expect(typeof rawBody).toBe("string");
    const body = JSON.parse(rawBody as string) as Record<string, string>;
    expect(body["code"]).toBe("authcode_xyz");
    expect(body["redirect_uri"]).toBe(redirectUri);
    // code_verifier must be present and non-empty (but never logged/exposed further)
    const verifier = body["code_verifier"] ?? "";
    expect(verifier.length).toBeGreaterThan(0);
  });

  it("rejects with 'state mismatch (possible CSRF)' when state does not match", async () => {
    const loginPromise = browserLogin({
      apiUrl: "https://api.test.oxagen.sh",
      appUrl: "https://app.test.oxagen.sh",
    });

    await waitFor(() => expect(mockOpenBrowser).toHaveBeenCalledOnce());
    const authorizeUrl = mockOpenBrowser.mock.calls[0]![0];
    const port = portFromAuthorizeUrl(authorizeUrl);

    const query = new URLSearchParams({
      code: "someCode",
      state: "tampered_state_value",
    }).toString();

    // Fire the callback without awaiting it first, so the rejection handler on
    // `loginPromise` is registered before `reject()` is called by the server.
    // Awaiting sendCallback after reject() fires causes an "unhandled rejection"
    // warning because there is a brief gap before rejects.toThrow() registers.
    void sendCallback(port, query);
    await expect(loginPromise).rejects.toThrow("state mismatch (possible CSRF)");

    // fetch should NOT have been called (exchange must not happen on bad state)
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects with the error param when the provider returns an error callback", async () => {
    const loginPromise = browserLogin({
      apiUrl: "https://api.test.oxagen.sh",
      appUrl: "https://app.test.oxagen.sh",
    });

    await waitFor(() => expect(mockOpenBrowser).toHaveBeenCalledOnce());
    const authorizeUrl = mockOpenBrowser.mock.calls[0]![0];
    const port = portFromAuthorizeUrl(authorizeUrl);
    const state = stateFromAuthorizeUrl(authorizeUrl);

    const query = new URLSearchParams({
      error: "access_denied",
      state,
    }).toString();

    void sendCallback(port, query);
    await expect(loginPromise).rejects.toThrow("access_denied");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects with the server error_description when token exchange returns non-200", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "invalid_grant",
        error_description: "Authorization code has already been used",
      }),
    } as Response);

    const loginPromise = browserLogin({
      apiUrl: "https://api.test.oxagen.sh",
      appUrl: "https://app.test.oxagen.sh",
    });

    await waitFor(() => expect(mockOpenBrowser).toHaveBeenCalledOnce());
    const authorizeUrl = mockOpenBrowser.mock.calls[0]![0];
    const port = portFromAuthorizeUrl(authorizeUrl);
    const state = stateFromAuthorizeUrl(authorizeUrl);

    const query = new URLSearchParams({ code: "reused_code", state }).toString();

    void sendCallback(port, query);
    await expect(loginPromise).rejects.toThrow(
      "Authorization code has already been used",
    );
  });
});
