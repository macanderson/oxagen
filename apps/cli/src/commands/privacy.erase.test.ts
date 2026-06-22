import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock api-client before importing the command so the module factory is hoisted
vi.mock("../lib/api-client.js", () => ({
  requireAuth: vi.fn(),
  apiRequest: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));

// readline is used for the interactive CONFIRM prompt — mock it so tests don't block on stdin
vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_msg: string, cb: (answer: string) => void) => cb("CONFIRM")),
    close: vi.fn(),
  })),
}));

import * as apiClientModule from "../lib/api-client.js";
import { privacyEraseCommand } from "./privacy.erase.js";

const mockRequireAuth = vi.mocked(apiClientModule.requireAuth);
const mockApiRequest = vi.mocked(apiClientModule.apiRequest);
// Retrieve ApiError from the mock module so instanceof checks work against the same class
const { ApiError } = apiClientModule as unknown as {
  ApiError: new (status: number, message: string) => Error & { status: number };
};

beforeEach(() => {
  vi.clearAllMocks();
  // privacyEraseCommand is a module-level singleton; Commander retains parsed
  // option values across parseAsync() calls, so a prior test's `--scope org`
  // leaks into the next parse and trips the org-id guard. Reset to declared
  // defaults before each test so every parse starts from a clean slate.
  privacyEraseCommand.setOptionValue("scope", "user");
  privacyEraseCommand.setOptionValue("orgId", undefined);
  privacyEraseCommand.setOptionValue("yes", undefined);
});

/**
 * Invoke the command action directly by parsing the given argv.
 * We call parseAsync so the async action handler runs to completion.
 */
async function runCommand(argv: string[]): Promise<void> {
  await privacyEraseCommand.parseAsync(argv, { from: "user" });
}

describe("privacy erase command — requireAuth gate", () => {
  it("calls requireAuth() before any other logic", async () => {
    // requireAuth throws (simulating process.exit) so we can assert it ran
    mockRequireAuth.mockImplementation(() => {
      throw new Error("not authenticated");
    });

    await expect(runCommand(["--yes"])).rejects.toThrow("not authenticated");

    // requireAuth must have been called
    expect(mockRequireAuth).toHaveBeenCalledTimes(1);
    // apiRequest must NOT have been called — auth check came first
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it("calls requireAuth() before showing the interactive confirmation prompt", async () => {
    // Simulate unauthenticated: requireAuth exits before the prompt
    let requireAuthCalled = false;
    mockRequireAuth.mockImplementation(() => {
      requireAuthCalled = true;
      throw new Error("exit:1");
    });

    await expect(runCommand([])).rejects.toThrow("exit:1");

    expect(requireAuthCalled).toBe(true);
    // apiRequest should not be reached
    expect(mockApiRequest).not.toHaveBeenCalled();
  });
});

describe("privacy erase command — authenticated flow", () => {
  beforeEach(() => {
    // Pass-through: auth is satisfied
    mockRequireAuth.mockReturnValue(undefined);
  });

  it("exits non-zero for invalid --scope value", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code ?? 0}`);
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCommand(["--scope", "invalid", "--yes"])).rejects.toThrow("exit:1");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("--scope must be"));

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("exits non-zero when --scope=org and --org-id is missing", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code ?? 0}`);
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCommand(["--scope", "org", "--yes"])).rejects.toThrow("exit:1");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("--org-id is required"));

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("sends POST to /privacy/erase with --yes flag (skips confirmation)", async () => {
    mockApiRequest.mockResolvedValueOnce({
      requestId: "req-123",
      status: "scheduled",
      effectiveAt: "2026-06-21T00:00:00Z",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCommand(["--yes"]);

    expect(mockApiRequest).toHaveBeenCalledWith(
      "/privacy/erase",
      expect.objectContaining({ method: "POST" }),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("req-123"));

    logSpy.mockRestore();
  });

  it("sends POST with orgId when --scope=org", async () => {
    mockApiRequest.mockResolvedValueOnce({
      requestId: "req-456",
      status: "scheduled",
      effectiveAt: "2026-06-21T00:00:00Z",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCommand(["--scope", "org", "--org-id", "org-abc", "--yes"]);

    expect(mockApiRequest).toHaveBeenCalledWith(
      "/privacy/erase",
      expect.objectContaining({
        body: expect.stringContaining("org-abc"),
      }),
    );

    logSpy.mockRestore();
  });

  it("prints error and exits non-zero on ApiError", async () => {
    mockApiRequest.mockRejectedValueOnce(new ApiError(401, "Unauthorized"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    await expect(runCommand(["--yes"])).rejects.toThrow("exit:1");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Unauthorized"));

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
