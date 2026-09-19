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
 *   5. A socket the browser opened and never used is destroyed when the flow
 *      settles, so the process is free to exit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";

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

/** What the loopback server answered the browser with. */
interface CallbackResponse {
  status: number;
  location: string | null;
}

/**
 * Send a GET request to the loopback server and wait for the response to end.
 * Resolves with the status and Location the browser would have followed.
 */
function sendCallback(port: number, query: string): Promise<CallbackResponse> {
  return new Promise<CallbackResponse>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/callback?${query}`,
        method: "GET",
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location ?? null,
          }),
        );
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

    const query = new URLSearchParams({
      code: "authcode_xyz",
      state,
    }).toString();
    const answer = await sendCallback(port, query);

    // The browser ends on the app's completion page, not on HTML served from
    // the loopback port: a localhost address as the last thing the user sees
    // reads as a misdirected redirect.
    expect(answer.status).toBe(302);
    expect(answer.location).toBe("https://app.test.oxagen.sh/cli/complete");

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

  it("releases every socket once the flow settles, so the process can exit", async () => {
    // The bug this covers: `server.close()` stops the listener but waits for
    // open connections, and a browser leaves them behind. Two of them: the
    // keep-alive socket that carried the callback, and any it preconnected
    // and never used. Node holds an unused one for `requestTimeout` (5
    // minutes by default). That kept the `oxagen login` process alive for
    // five minutes after the user was already signed in, and with it the
    // desktop app's "Waiting for the browser" state.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        token: "tok_test_abc123",
        orgSlug: "acme",
        workspaceSlug: "main",
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

    // What a browser preconnect looks like: connected, nothing sent.
    const idle = net.connect(port, "127.0.0.1");
    await new Promise<void>((r, reject) => {
      idle.once("connect", () => r());
      idle.once("error", reject);
    });
    expect(idle.destroyed).toBe(false);

    await sendCallback(
      port,
      new URLSearchParams({ code: "authcode_xyz", state }).toString(),
    );
    await loginPromise;

    // The listener is gone and the unused socket with it. Both ends see the
    // close, so nothing is left attached to the event loop.
    await waitFor(() =>
      expect(idle.readableEnded || idle.destroyed).toBe(true),
    );
    await expect(sendCallback(port, "code=late&state=late")).rejects.toThrow();
    idle.destroy();
  });

  it("signup opens the sign-up page with the consent page as its returnTo, and the callback is unchanged", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "tok", orgSlug: "new", workspaceSlug: "ws" }),
    } as Response);
    const statusLines: string[] = [];
    const loginPromise = browserLogin({
      apiUrl: "https://api.test.oxagen.sh",
      appUrl: "https://app.test.oxagen.sh",
      signup: true,
      onStatus: (line) => statusLines.push(line),
    });
    await waitFor(() => expect(mockOpenBrowser).toHaveBeenCalledOnce());
    const opened = new URL(mockOpenBrowser.mock.calls[0]![0]);
    expect(opened.origin + opened.pathname).toBe(
      "https://app.test.oxagen.sh/signup",
    );
    // returnTo is the same authorize path the plain flow opens directly,
    // PKCE parameters included, so the account lands on the consent page.
    const returnTo = opened.searchParams.get("returnTo") ?? "";
    expect(returnTo.startsWith("/cli/authorize?")).toBe(true);
    const authorize = new URL(returnTo, "https://app.test.oxagen.sh");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("state")).toBeTruthy();
    expect(statusLines[0]).toContain("create your Oxagen account");
    const port = portFromAuthorizeUrl(authorize.toString());
    const state = stateFromAuthorizeUrl(authorize.toString());
    await sendCallback(
      port,
      new URLSearchParams({ code: "authcode_new", state }).toString(),
    );
    expect(await loginPromise).toEqual({
      token: "tok",
      orgSlug: "new",
      workspaceSlug: "ws",
    });
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
    await expect(loginPromise).rejects.toThrow(
      "state mismatch (possible CSRF)",
    );

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

    const query = new URLSearchParams({
      code: "reused_code",
      state,
    }).toString();

    void sendCallback(port, query);
    await expect(loginPromise).rejects.toThrow(
      "Authorization code has already been used",
    );
  });
});
