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
  getToken: vi.fn(),
  getOrgId: vi.fn(),
  getWorkspaceId: vi.fn(),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  clearConfig: vi.fn(),
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
import { handleLogin, handleLogout, validatePlatformToken } from "../auth.js";

const mockGetApiUrl = getApiUrl as ReturnType<typeof vi.fn>;
const mockGetToken = getToken as ReturnType<typeof vi.fn>;
const mockGetOrgId = getOrgId as ReturnType<typeof vi.fn>;
const mockGetWorkspaceId = getWorkspaceId as ReturnType<typeof vi.fn>;
const mockReadConfig = readConfig as ReturnType<typeof vi.fn>;
const mockWriteConfig = writeConfig as ReturnType<typeof vi.fn>;
const mockClearConfig = clearConfig as ReturnType<typeof vi.fn>;

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
      "https://api.oxagen.sh/v1/user/preferences/read",
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
    mockGetToken.mockReturnValue("tok_existing");
    mockGetOrgId.mockReturnValue("acme");
    mockGetWorkspaceId.mockReturnValue("main");

    await handleLogin({});

    expect(stdout).toContain("Logged in to Oxagen");
    expect(stdout).toContain("acme");
    expect(stdout).toContain("main");
    // Token should be masked
    expect(stdout).not.toContain("tok_existing");
    expect(mockFetch).not.toHaveBeenCalled();
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

  it("sets exitCode 1 when org is missing and not TTY", async () => {
    await handleLogin({ token: "tok_valid", workspace: "main" });

    expect(stderr).toContain("No org provided");
    expect(process.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sets exitCode 1 when workspace is missing and not TTY", async () => {
    await handleLogin({ token: "tok_valid", org: "acme" });

    expect(stderr).toContain("No workspace provided");
    expect(process.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses config values as defaults when no flags are passed", async () => {
    mockReadConfig.mockReturnValue({
      token: "tok_config",
      orgSlug: "config-org",
      workspaceSlug: "config-ws",
    });
    mockFetch.mockResolvedValue({ ok: true });

    await handleLogin({});

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.oxagen.sh/v1/user/preferences/read",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok_config" }),
      }),
    );
    expect(mockWriteConfig).toHaveBeenCalledWith({
      token: "tok_config",
      orgSlug: "config-org",
      workspaceSlug: "config-ws",
    });
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
