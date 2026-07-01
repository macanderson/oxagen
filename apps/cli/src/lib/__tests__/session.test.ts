/**
 * Session helper unit tests — proves `loadSession` and `requireSession`
 * behave correctly for the account-required gate (ADR-019 §4).
 *
 * All config reads are mocked so no filesystem is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../config.js", () => ({
  getToken: vi.fn(),
  getOrgId: vi.fn(),
  getWorkspaceId: vi.fn(),
  getApiUrl: vi.fn(() => "https://api.oxagen.sh"),
}));

import { getToken, getOrgId, getWorkspaceId, getApiUrl } from "../config.js";
import { loadSession, requireSession } from "../session.js";

const mockToken = getToken as ReturnType<typeof vi.fn>;
const mockOrg = getOrgId as ReturnType<typeof vi.fn>;
const mockWs = getWorkspaceId as ReturnType<typeof vi.fn>;
const mockApiUrl = getApiUrl as ReturnType<typeof vi.fn>;

let stderrOut = "";
const origStderr = process.stderr.write.bind(process.stderr);
let exitCalled: number | undefined;
const origExit = process.exit.bind(process);

beforeEach(() => {
  stderrOut = "";
  exitCalled = undefined;
  process.stderr.write = ((s: string) => {
    stderrOut += s;
    return true;
  }) as typeof process.stderr.write;
  // Prevent actual process.exit — capture the code instead.
  vi.spyOn(process, "exit").mockImplementation(
    (code?: string | number | null) => {
      exitCalled = typeof code === "number" ? code : 0;
      throw new Error(`process.exit(${code ?? 0})`);
    },
  );
  mockApiUrl.mockReturnValue("https://api.oxagen.sh");
});

afterEach(() => {
  process.stderr.write = origStderr;
  vi.restoreAllMocks();
});

// ── loadSession ───────────────────────────────────────────────────────────────

describe("loadSession", () => {
  it("returns a Session when all three fields are present", () => {
    mockToken.mockReturnValue("tok_abc123");
    mockOrg.mockReturnValue("acme");
    mockWs.mockReturnValue("main");

    const session = loadSession();
    expect(session).toEqual({
      token: "tok_abc123",
      orgSlug: "acme",
      workspaceSlug: "main",
      apiUrl: "https://api.oxagen.sh",
    });
  });

  it("returns null when token is missing", () => {
    mockToken.mockReturnValue(undefined);
    mockOrg.mockReturnValue("acme");
    mockWs.mockReturnValue("main");
    expect(loadSession()).toBeNull();
  });

  it("returns null when org is missing", () => {
    mockToken.mockReturnValue("tok_abc123");
    mockOrg.mockReturnValue(undefined);
    mockWs.mockReturnValue("main");
    expect(loadSession()).toBeNull();
  });

  it("returns null when workspace is missing", () => {
    mockToken.mockReturnValue("tok_abc123");
    mockOrg.mockReturnValue("acme");
    mockWs.mockReturnValue(undefined);
    expect(loadSession()).toBeNull();
  });

  it("returns null when all fields are missing", () => {
    mockToken.mockReturnValue(undefined);
    mockOrg.mockReturnValue(undefined);
    mockWs.mockReturnValue(undefined);
    expect(loadSession()).toBeNull();
  });
});

// ── requireSession ────────────────────────────────────────────────────────────

describe("requireSession", () => {
  it("returns the session when all fields are present", () => {
    mockToken.mockReturnValue("tok_valid");
    mockOrg.mockReturnValue("my-org");
    mockWs.mockReturnValue("my-ws");

    const session = requireSession();
    expect(session).toEqual({
      token: "tok_valid",
      orgSlug: "my-org",
      workspaceSlug: "my-ws",
      apiUrl: "https://api.oxagen.sh",
    });
    expect(exitCalled).toBeUndefined();
  });

  it("exits 1 and prints error when token is missing", () => {
    mockToken.mockReturnValue(undefined);
    mockOrg.mockReturnValue("my-org");
    mockWs.mockReturnValue("my-ws");

    expect(() => requireSession()).toThrow("process.exit(1)");
    expect(exitCalled).toBe(1);
    expect(stderrOut).toContain("token");
    expect(stderrOut).toContain("oxagen login");
  });

  it("exits 1 and prints error when org is missing", () => {
    mockToken.mockReturnValue("tok_valid");
    mockOrg.mockReturnValue(undefined);
    mockWs.mockReturnValue("my-ws");

    expect(() => requireSession()).toThrow("process.exit(1)");
    expect(exitCalled).toBe(1);
    expect(stderrOut).toContain("org");
    expect(stderrOut).toContain("oxagen login");
  });

  it("exits 1 and prints error when workspace is missing", () => {
    mockToken.mockReturnValue("tok_valid");
    mockOrg.mockReturnValue("my-org");
    mockWs.mockReturnValue(undefined);

    expect(() => requireSession()).toThrow("process.exit(1)");
    expect(exitCalled).toBe(1);
    expect(stderrOut).toContain("workspace");
    expect(stderrOut).toContain("oxagen login");
  });

  it("lists all missing fields when nothing is configured", () => {
    mockToken.mockReturnValue(undefined);
    mockOrg.mockReturnValue(undefined);
    mockWs.mockReturnValue(undefined);

    expect(() => requireSession()).toThrow("process.exit(1)");
    expect(stderrOut).toContain("token");
    expect(stderrOut).toContain("org");
    expect(stderrOut).toContain("workspace");
  });
});
