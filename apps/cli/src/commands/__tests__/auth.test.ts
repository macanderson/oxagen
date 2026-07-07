/**
 * Auth command unit tests — `oxagen login` / `oxagen logout`.
 *
 * Mocks: config reads/writes, the platform fetch (validatePlatformToken),
 * and process I/O. No actual network calls or filesystem writes are made.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock config module before any imports
vi.mock("../../lib/config.js", () => ({
  getApiUrl: vi.fn(() => "https://api.oxagen.sh"),
  // getAppUrl is read by handleLogin (browser-login flow added in the CLI
  // browser-login work). Headless/token tests don't use the app URL, but the
  // call still runs at the top of handleLogin, so the mock must export it.
  getAppUrl: vi.fn(() => "https://app.oxagen.sh"),
  getToken: vi.fn(),
  getOrgId: vi.fn(),
  getWorkspaceId: vi.fn(),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  clearConfig: vi.fn(),
}));

// Mock the org/workspace picker. handleLogin delegates scope resolution to the
// linker (which has its own tests); here we only need to control what it
// returns / whether it throws.
vi.mock("../../lib/linker.js", () => ({
  resolveLinkedAccount: vi.fn(),
}));

// Mock the browser-based PKCE loopback flow — runBrowserLogin's tests (below)
// exercise only its own persistence contract, never the real HTTP
// server/browser-open side effects (those are lib/loopback-login.ts's own
// unit tests).
vi.mock("../../lib/loopback-login.js", () => ({
  browserLogin: vi.fn(),
}));

// Mock fetch to avoid real network calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  getApiUrl,
  getToken,
  getOrgId,
  getWorkspaceId,
  readConfig,
  writeConfig,
  clearConfig,
} from "../../lib/config.js";
import { resolveLinkedAccount } from "../../lib/linker.js";
import { browserLogin } from "../../lib/loopback-login.js";
import { handleLogin, handleLogout, validatePlatformToken, runBrowserLogin } from "../auth.js";

const mockBrowserLogin = browserLogin as ReturnType<typeof vi.fn>;

const mockGetApiUrl = getApiUrl as ReturnType<typeof vi.fn>;
const mockGetToken = getToken as ReturnType<typeof vi.fn>;
const mockGetOrgId = getOrgId as ReturnType<typeof vi.fn>;
const mockGetWorkspaceId = getWorkspaceId as ReturnType<typeof vi.fn>;
const mockReadConfig = readConfig as ReturnType<typeof vi.fn>;
const mockWriteConfig = writeConfig as ReturnType<typeof vi.fn>;
const mockClearConfig = clearConfig as ReturnType<typeof vi.fn>;
const mockResolveLinkedAccount = resolveLinkedAccount as ReturnType<typeof vi.fn>;

/** A fully-resolved account, as the linker returns it on the happy path. */
function linkedAccount(orgSlug = "acme", workspaceSlug = "main") {
  return {
    orgId: "org-id",
    orgSlug,
    orgName: orgSlug,
    workspaceId: "ws-id",
    workspaceSlug,
    workspaceName: workspaceSlug,
  };
}

let stdout = "";
let stderr = "";
const origStdout = process.stdout.write.bind(process.stdout);
const origStderr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  stdout = "";
  stderr = "";
  process.stdout.write = ((s: string) => {
    stdout += s;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    stderr += s;
    return true;
  }) as typeof process.stderr.write;
  process.exitCode = undefined;
  mockGetApiUrl.mockReturnValue("https://api.oxagen.sh");
  mockReadConfig.mockReturnValue({});
  mockGetToken.mockReturnValue(undefined);
  mockGetOrgId.mockReturnValue(undefined);
  mockGetWorkspaceId.mockReturnValue(undefined);
  mockFetch.mockReset();
  // Default: the picker succeeds and resolves to acme/main. Tests that exercise
  // the failure path override this with mockRejectedValue.
  mockResolveLinkedAccount.mockReset();
  mockResolveLinkedAccount.mockResolvedValue(linkedAccount());
});

afterEach(() => {
  process.stdout.write = origStdout;
  process.stderr.write = origStderr;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

// ── validatePlatformToken ────────────────────────────────────────────────────

describe("validatePlatformToken", () => {
  it("returns kind:valid for a 200 response", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const result = await validatePlatformToken("tok_valid", "https://api.oxagen.sh");
    expect(result).toEqual({ kind: "valid" });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.oxagen.sh/v1/auth/whoami",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer tok_valid",
        }),
      }),
    );
  });

  it("returns kind:invalid for a 401 response (auth layer rejected the key)", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });
    const result = await validatePlatformToken("tok_bad", "https://api.oxagen.sh");
    expect(result).toEqual({ kind: "invalid" });
  });

  it("returns kind:forbidden for a 403 response (valid key, IAM denied)", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    const result = await validatePlatformToken("tok_real", "https://api.oxagen.sh");
    expect(result).toEqual({ kind: "forbidden" });
  });

  it("returns kind:unexpected for other non-ok statuses", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const result = await validatePlatformToken("tok_x", "https://api.oxagen.sh");
    expect(result).toEqual({ kind: "unexpected", status: 500 });
  });

  it("returns kind:network with detail on network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await validatePlatformToken("tok_bad", "https://api.oxagen.sh");
    expect(result).toEqual({ kind: "network", detail: "ECONNREFUSED" });
  });
});

// ── handleLogin — already logged in ─────────────────────────────────────────

describe("handleLogin — already logged in", () => {
  it("shows current session when called with no flags and session exists", async () => {
    // handleLogin reads the token via getToken() and the org/workspace slugs
    // from the persisted config (readConfig), not getOrgId/getWorkspaceId.
    mockGetToken.mockReturnValue("tok_existing");
    mockReadConfig.mockReturnValue({ orgSlug: "acme", workspaceSlug: "main" });

    await handleLogin({});

    expect(stdout).toContain("Logged in to Oxagen");
    expect(stdout).toContain("acme");
    expect(stdout).toContain("main");
    // Token should be masked
    expect(stdout).not.toContain("tok_existing");
    expect(mockFetch).not.toHaveBeenCalled();
    // Already-logged-in short-circuits before the picker.
    expect(mockResolveLinkedAccount).not.toHaveBeenCalled();
  });
});

// ── handleLogin — headless (non-TTY) ────────────────────────────────────────

describe("handleLogin — headless (--token/--org/--workspace flags)", () => {
  let origIsTTY: boolean | undefined;

  beforeEach(() => {
    // Simulate non-TTY environment so prompt is not attempted.
    // `process.stdin.isTTY` is a plain property (not a getter), so we must
    // use Object.defineProperty — vi.spyOn(..., "get") does not apply.
    origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: origIsTTY,
      configurable: true,
      writable: true,
    });
  });

  it("authenticates and persists session when all flags provided and token is valid", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await handleLogin({ token: "tok_new", org: "acme", workspace: "main" });

    expect(mockWriteConfig).toHaveBeenCalledWith({
      token: "tok_new",
      orgSlug: "acme",
      workspaceSlug: "main",
      appUrl: "https://app.oxagen.sh",
    });
    expect(stdout).toContain("Logged in to Oxagen");
    expect(stdout).toContain("acme");
    expect(stdout).toContain("main");
    expect(process.exitCode).toBeFalsy();
  });

  it("sets exitCode 1 when token validation fails (401 invalid key)", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

    await handleLogin({ token: "tok_bad", org: "acme", workspace: "main" });

    expect(mockWriteConfig).not.toHaveBeenCalled();
    expect(stderr).toContain("Token validation failed");
    expect(process.exitCode).toBe(1);
  });

  it("persists the session and warns when the key is valid but IAM-denied (403)", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });

    await handleLogin({ token: "tok_real", org: "acme", workspace: "main" });

    // A 403 proves the key is real — login must succeed, not reject it.
    expect(mockWriteConfig).toHaveBeenCalledWith({
      token: "tok_real",
      orgSlug: "acme",
      workspaceSlug: "main",
      appUrl: "https://app.oxagen.sh",
    });
    expect(stdout).toContain("Logged in to Oxagen");
    expect(stderr).toContain("403");
    expect(stderr).toContain("acme");
    expect(process.exitCode).toBeFalsy();
  });

  it("does not persist and sets exitCode 1 on an unexpected status (500)", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await handleLogin({ token: "tok_x", org: "acme", workspace: "main" });

    expect(mockWriteConfig).not.toHaveBeenCalled();
    expect(stderr).toContain("Unexpected response (HTTP 500)");
    expect(process.exitCode).toBe(1);
  });

  it("does not persist and sets exitCode 1 on a network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    await handleLogin({ token: "tok_x", org: "acme", workspace: "main" });

    expect(mockWriteConfig).not.toHaveBeenCalled();
    expect(stderr).toContain("Network error");
    expect(stderr).toContain("ECONNREFUSED");
    expect(process.exitCode).toBe(1);
  });

  it("sets exitCode 1 when token is missing and not TTY", async () => {
    await handleLogin({ org: "acme", workspace: "main" });

    expect(stderr).toContain("No token provided");
    expect(process.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("resolves org/workspace via the picker when --org/--workspace are omitted", async () => {
    // Org/workspace are no longer required flags: a valid key plus the linker
    // (auto-select or prompt) resolves the scope. Pass only the token.
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    mockResolveLinkedAccount.mockResolvedValue(linkedAccount("picked-org", "picked-ws"));

    await handleLogin({ token: "tok_valid" });

    expect(mockResolveLinkedAccount).toHaveBeenCalledWith(
      expect.objectContaining({ orgSlug: undefined, workspaceSlug: undefined }),
    );
    expect(mockWriteConfig).toHaveBeenCalledWith({
      token: "tok_valid",
      orgSlug: "picked-org",
      workspaceSlug: "picked-ws",
      appUrl: "https://app.oxagen.sh",
    });
    expect(process.exitCode).toBeFalsy();
  });

  it("clears the partial config and sets exitCode 1 when the picker fails", async () => {
    // The token is persisted before the picker runs (so the linker's API calls
    // can authenticate). If the picker then fails — e.g. no orgs, ambiguous in
    // non-TTY — login must not leave a token with no scope behind.
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    mockResolveLinkedAccount.mockRejectedValue(
      new Error("No organizations found for this account."),
    );

    await handleLogin({ token: "tok_valid" });

    expect(mockWriteConfig).toHaveBeenCalledWith({
      token: undefined,
      orgSlug: undefined,
      workspaceSlug: undefined,
    });
    // The stable contract is: no partial config left behind + non-zero exit +
    // an error surfaced. (We don't couple to the exact catch-block wording,
    // which the login flow has churned.)
    expect(stderr).toContain("Error:");
    expect(process.exitCode).toBe(1);
  });

  it("uses the config token as the default and resolves scope via the picker", async () => {
    // No flags and no live session (getToken undefined) → fall through to the
    // interactive flow, defaulting the token to config.token and probing with
    // it. Scope then comes from the picker, not from config.
    mockReadConfig.mockReturnValue({
      token: "tok_config",
      orgSlug: "config-org",
      workspaceSlug: "config-ws",
    });
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    mockResolveLinkedAccount.mockResolvedValue(linkedAccount("picked-org", "picked-ws"));

    await handleLogin({});

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.oxagen.sh/v1/auth/whoami",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok_config" }),
      }),
    );
    expect(mockWriteConfig).toHaveBeenCalledWith({
      token: "tok_config",
      orgSlug: "picked-org",
      workspaceSlug: "picked-ws",
      appUrl: "https://app.oxagen.sh",
    });
  });
});

// ── runBrowserLogin — the UI-agnostic core the REPL's Ink /login panel uses ─

describe("runBrowserLogin", () => {
  beforeEach(() => {
    mockBrowserLogin.mockReset();
  });

  it("persists the session returned by browserLogin via writeConfig — the exact same shape `oxagen login` writes", async () => {
    mockBrowserLogin.mockResolvedValue({ token: "tok_x", orgSlug: "acme", workspaceSlug: "main" });

    const result = await runBrowserLogin();

    expect(result).toEqual({ token: "tok_x", orgSlug: "acme", workspaceSlug: "main" });
    expect(mockWriteConfig).toHaveBeenCalledWith({
      token: "tok_x",
      orgSlug: "acme",
      workspaceSlug: "main",
      appUrl: "https://app.oxagen.sh",
    });
  });

  it("passes onStatus/signal straight through to browserLogin (no readline, no direct stdout write)", async () => {
    mockBrowserLogin.mockResolvedValue({ token: "t", orgSlug: "o", workspaceSlug: "w" });
    const onStatus = vi.fn();
    const controller = new AbortController();

    await runBrowserLogin(onStatus, controller.signal);

    expect(mockBrowserLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        apiUrl: "https://api.oxagen.sh",
        appUrl: "https://app.oxagen.sh",
        onStatus,
        signal: controller.signal,
      }),
    );
    // The status callback is the ONLY channel status lines can reach — proves
    // this call path never falls back to a hardcoded process.stdout.write.
    expect(stdout).toBe("");
  });

  it("propagates a browserLogin rejection (e.g. cancelled via the signal) without persisting anything", async () => {
    mockBrowserLogin.mockRejectedValue(new Error("Login cancelled."));

    await expect(runBrowserLogin()).rejects.toThrow("Login cancelled.");
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });
});

// ── handleLogout ─────────────────────────────────────────────────────────────

describe("handleLogout", () => {
  it("clears config and confirms logout when session exists", () => {
    mockReadConfig.mockReturnValue({ token: "tok_x", orgSlug: "org", workspaceSlug: "ws" });

    handleLogout();

    expect(mockClearConfig).toHaveBeenCalled();
    expect(stdout).toContain("Logged out");
  });

  it("says 'Not logged in' without clearing config when no session", () => {
    mockReadConfig.mockReturnValue({});

    handleLogout();

    expect(mockClearConfig).not.toHaveBeenCalled();
    expect(stdout).toContain("Not logged in");
  });
});
