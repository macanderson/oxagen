/**
 * `oxagen file-lock` handler unit tests.
 *
 * Strategy:
 *   - Mock `../../lib/api.js` so apiGetOrThrow/apiPostOrThrow return
 *     controlled results, or throw ApiError.
 *   - Capture stdout/stderr and process.exitCode to assert on output.
 *
 * Output discipline (ADR-023 §4): success/data → stdout; a bad flag is a usage
 * error (exit 2), an API failure is a uniform `✗ …` stderr line (exit 1); a
 * denied lock is a real result printed to stdout with a non-zero exit.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";

vi.mock("../../lib/api.js", () => ({
  apiGetOrThrow: vi.fn(),
  apiPostOrThrow: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
  printTable: vi.fn((headers: string[], rows: string[][]) => {
    process.stdout.write(`${headers.join("|")}\n`);
    for (const r of rows) process.stdout.write(`${r.join("|")}\n`);
  }),
}));

import {
  handleFileLockList,
  handleFileLockAcquire,
  handleFileLockRelease,
} from "../file-lock.js";
import { apiGetOrThrow, apiPostOrThrow, ApiError } from "../../lib/api.js";

const mockGet = apiGetOrThrow as unknown as Mock;
const mockPost = apiPostOrThrow as unknown as Mock;

let out = "";
let err = "";
const restorers: Array<() => void> = [];

beforeEach(() => {
  out = "";
  err = "";
  process.exitCode = undefined;

  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    s: unknown,
  ) => {
    out += String(s);
    return true;
  }) as never);
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    s: unknown,
  ) => {
    err += String(s);
    return true;
  }) as never);

  restorers.push(
    () => outSpy.mockRestore(),
    () => errSpy.mockRestore(),
  );
});

afterEach(() => {
  for (const r of restorers.splice(0)) r();
  process.exitCode = undefined;
  mockGet.mockReset();
  mockPost.mockReset();
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("handleFileLockList", () => {
  const LOCK = {
    lockId: "lock-1",
    naturalKey: "github:acme/repo:src/foo.ts",
    agentId: "agent-a",
    acquiredAt: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000,
    workspaceId: "ws-1",
    action: "write",
    executionId: "exec-1",
  };

  it("prints a human-readable table on success", async () => {
    mockGet.mockResolvedValueOnce({ locks: [LOCK] });

    await handleFileLockList({});

    expect(mockGet).toHaveBeenCalledWith("agent/file/lock/list", {
      path: undefined,
      owner: undefined,
      repo: undefined,
    });
    expect(out).toContain("LOCK ID");
    expect(out).toContain("lock-1");
    expect(out).toContain("github:acme/repo:src/foo.ts");
  });

  it("forwards path/owner/repo filters as query params", async () => {
    mockGet.mockResolvedValueOnce({ locks: [] });

    await handleFileLockList({
      path: "src/foo.ts",
      owner: "acme",
      repo: "repo",
    });

    expect(mockGet).toHaveBeenCalledWith("agent/file/lock/list", {
      path: "src/foo.ts",
      owner: "acme",
      repo: "repo",
    });
  });

  it("prints an empty-state message when there are no live locks", async () => {
    mockGet.mockResolvedValueOnce({ locks: [] });

    await handleFileLockList({});

    expect(out).toContain("No live file locks.");
  });

  it("outputs a single-line JSON value when --json is passed", async () => {
    mockGet.mockResolvedValueOnce({ locks: [LOCK] });

    await handleFileLockList({ json: true });

    expect(out.trim()).toBe(JSON.stringify({ locks: [LOCK] }));
    const parsed = JSON.parse(out) as { locks: unknown[] };
    expect(parsed.locks).toHaveLength(1);
  });

  it("exits 1 with a uniform error line on ApiError", async () => {
    mockGet.mockRejectedValueOnce(new ApiError("Not logged in."));

    await handleFileLockList({});

    expect(err).toMatch(/^✗ /);
    expect(err).toContain("Not logged in.");
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// acquire
// ---------------------------------------------------------------------------

describe("handleFileLockAcquire", () => {
  it("prints a success message and forwards fields when granted", async () => {
    mockPost.mockResolvedValueOnce({
      granted: true,
      lockId: "lock-2",
      heldBy: null,
      blockedUntil: null,
    });

    await handleFileLockAcquire("src/foo.ts", {
      owner: "acme",
      repo: "repo",
      action: "write",
      ttlMs: "60000",
      agentId: "agent-a",
      executionId: "exec-1",
    });

    expect(mockPost).toHaveBeenCalledWith("agent/file/lock/acquire", {
      path: "src/foo.ts",
      owner: "acme",
      repo: "repo",
      action: "write",
      ttlMs: 60000,
      agentId: "agent-a",
      executionId: "exec-1",
    });
    expect(out).toContain("Lock granted");
    expect(out).toContain("lock-2");
  });

  it("outputs JSON when --json is passed", async () => {
    mockPost.mockResolvedValueOnce({
      granted: true,
      lockId: "lock-2",
      heldBy: null,
      blockedUntil: null,
    });

    await handleFileLockAcquire("src/foo.ts", { json: true });

    const parsed = JSON.parse(out) as { granted: boolean; lockId: string };
    expect(parsed.granted).toBe(true);
    expect(parsed.lockId).toBe("lock-2");
  });

  it("sets exitCode=1 and prints the conflicting holder when not granted", async () => {
    mockPost.mockResolvedValueOnce({
      granted: false,
      lockId: "",
      heldBy: "agent-b",
      blockedUntil: 1_700_000_300_000,
    });

    await handleFileLockAcquire("src/foo.ts", {});

    expect(process.exitCode).toBe(1);
    expect(out).toContain("agent-b");
  });

  it("rejects an invalid --action before calling the API (usage exit 2)", async () => {
    await handleFileLockAcquire("src/foo.ts", { action: "delete" });

    expect(err).toContain('Invalid --action "delete"');
    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric --ttl-ms before calling the API (usage exit 2)", async () => {
    await handleFileLockAcquire("src/foo.ts", { ttlMs: "soon" });

    expect(err).toContain('Invalid --ttl-ms "soon"');
    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("exits 1 with a uniform error line on ApiError", async () => {
    mockPost.mockRejectedValueOnce(
      new ApiError("Error 403 from agent/file/lock/acquire: forbidden", 403),
    );

    await handleFileLockAcquire("src/foo.ts", {});

    expect(err).toContain("forbidden");
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

describe("handleFileLockRelease", () => {
  it("prints a success message when released", async () => {
    mockPost.mockResolvedValueOnce({ released: true });

    await handleFileLockRelease("lock-1", {});

    expect(mockPost).toHaveBeenCalledWith("agent/file/lock/release", {
      lockId: "lock-1",
    });
    expect(out).toContain("Released lock lock-1");
  });

  it("prints an idempotent message (no error) when nothing was released", async () => {
    mockPost.mockResolvedValueOnce({ released: false });

    await handleFileLockRelease("lock-1", {});

    expect(process.exitCode).toBeUndefined();
    expect(out).toContain("No matching live lock");
  });

  it("outputs JSON when --json is passed", async () => {
    mockPost.mockResolvedValueOnce({ released: true });

    await handleFileLockRelease("lock-1", { json: true });

    const parsed = JSON.parse(out) as { released: boolean };
    expect(parsed.released).toBe(true);
  });

  it("exits 1 with a uniform error line on ApiError", async () => {
    mockPost.mockRejectedValueOnce(new ApiError("Not logged in."));

    await handleFileLockRelease("lock-1", {});

    expect(err).toContain("Not logged in.");
    expect(process.exitCode).toBe(1);
  });
});
