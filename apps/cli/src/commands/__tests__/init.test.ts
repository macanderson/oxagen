/**
 * Unit tests for `oxagen init` — the workspace linker, the GitHub-connection
 * step, the summary renderer, and the phase events runInit emits.
 *
 * The platform seams (lib/api, lib/config, lib/linker) are mocked, so every
 * path below runs offline and touches only a temp directory. `runInit` is the
 * observable surface: it writes `.oxagen/workspace.json` and returns a result
 * the CLI handler renders.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../lib/api.js", () => ({
  apiGetOrThrow: vi.fn(),
  apiPostOrThrow: vi.fn(),
}));
vi.mock("../../lib/config.js", () => ({ getToken: vi.fn() }));
vi.mock("../../lib/linker.js", () => ({ resolveLinkedAccount: vi.fn() }));

import {
  formatInitSummary,
  handleInit,
  runInit,
  type InitResult,
  type InitProgressEvent,
} from "../init.js";
import {
  readWorkspaceLink,
  writeWorkspaceLink,
  workspaceLinkPath,
} from "../workspace-link.js";
import { apiGetOrThrow, apiPostOrThrow } from "../../lib/api.js";
import { getToken } from "../../lib/config.js";
import { resolveLinkedAccount } from "../../lib/linker.js";

const mockGet = apiGetOrThrow as unknown as Mock;
const mockPost = apiPostOrThrow as unknown as Mock;
const mockToken = getToken as unknown as Mock;
const mockResolve = resolveLinkedAccount as unknown as Mock;

const ACCOUNT = {
  orgId: "org_1",
  orgSlug: "acme",
  orgName: "Acme Inc",
  workspaceId: "ws_1",
  workspaceSlug: "prod",
  workspaceName: "Production",
};

let tmpDir: string;
let out = "";
let stdout: typeof process.stdout.write;
let stderr: typeof process.stderr.write;
let isTTY: boolean | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "oxagen-init-test-"));
  out = "";
  stdout = process.stdout.write.bind(process.stdout);
  stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  isTTY = process.stdin.isTTY;
  // Non-interactive by default: the GitHub connect prompt must never block.
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });
  mockGet.mockReset();
  mockPost.mockReset();
  mockToken.mockReset();
  mockResolve.mockReset();
});

afterEach(() => {
  process.stdout.write = stdout;
  process.stderr.write = stderr;
  Object.defineProperty(process.stdin, "isTTY", {
    value: isTTY,
    configurable: true,
  });
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeResult(overrides: Partial<InitResult> = {}): InitResult {
  return {
    workspaceLinkPath: workspaceLinkPath(tmpDir),
    workspaceLink: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Summary rendering
// ---------------------------------------------------------------------------

describe("formatInitSummary", () => {
  it("names the workspace-link file it manages", () => {
    expect(formatInitSummary(makeResult())).toContain(
      join(tmpDir, ".oxagen", "workspace.json"),
    );
  });

  it("reports the skip when --no-link was passed", () => {
    expect(formatInitSummary(makeResult())).toContain("Skipped (--no-link)");
  });

  it("renders the linked workspace when the linker ran", () => {
    const out = formatInitSummary(
      makeResult({
        workspaceLink: {
          linked: true,
          orgSlug: "acme",
          orgName: "Acme Inc",
          workspaceSlug: "prod",
          workspaceName: "Production",
        },
      }),
    );
    expect(out).toContain("Acme Inc");
    expect(out).toContain("Production");
  });

  it("falls back to slugs when names are absent", () => {
    const out = formatInitSummary(
      makeResult({
        workspaceLink: {
          linked: true,
          orgSlug: "acme",
          workspaceSlug: "prod",
        },
      }),
    );
    expect(out).toContain("acme / prod");
  });

  it("lists linked repos, truncating past five", () => {
    const repos = Array.from({ length: 7 }, (_, i) => ({
      provider: "github" as const,
      fullName: `acme/repo-${i}`,
    }));
    const out = formatInitSummary(
      makeResult({ workspaceLink: { linked: true, orgSlug: "a", repos } }),
    );
    expect(out).toContain("acme/repo-0");
    expect(out).toContain("+2 more");
    expect(out).not.toContain("acme/repo-6");
  });

  it("renders the skip reason when linking could not run", () => {
    const out = formatInitSummary(
      makeResult({
        workspaceLink: {
          linked: false,
          skippedReason: "No platform session. Run `oxagen login`",
        },
      }),
    );
    expect(out).toContain("No platform session");
  });
});

// ---------------------------------------------------------------------------
// runInit — the linker step
// ---------------------------------------------------------------------------

describe("runInit --no-link", () => {
  it("skips the link phase entirely and emits no events", async () => {
    const events: InitProgressEvent[] = [];
    const result = await runInit({
      cwd: tmpDir,
      noLink: true,
      onProgress: (e) => {
        events.push(e);
      },
    });
    expect(events).toEqual([]);
    expect(result.workspaceLink).toBeNull();
    expect(result.workspaceLinkPath).toBe(workspaceLinkPath(tmpDir));
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("behaves identically when onProgress is omitted", async () => {
    const result = await runInit({ cwd: tmpDir, noLink: true });
    expect(result.workspaceLink).toBeNull();
  });
});

describe("runInit linker", () => {
  it("skips with guidance when there is no platform session", async () => {
    mockToken.mockReturnValue(undefined);
    const result = await runInit({ cwd: tmpDir });
    expect(result.workspaceLink?.linked).toBe(false);
    expect(result.workspaceLink?.skippedReason).toContain("oxagen login");
    expect(existsSync(workspaceLinkPath(tmpDir))).toBe(false);
  });

  it("emits start and done around the link phase", async () => {
    mockToken.mockReturnValue("oxk_live_x");
    mockResolve.mockResolvedValue(ACCOUNT);
    mockGet.mockResolvedValue({ connections: [] });
    const events: InitProgressEvent[] = [];
    await runInit({
      cwd: tmpDir,
      onProgress: (e) => {
        events.push(e);
      },
    });
    expect(events).toEqual([
      { phase: "link", status: "start" },
      { phase: "link", status: "done" },
    ]);
  });

  it("writes the workspace link the picker resolved", async () => {
    mockToken.mockReturnValue("oxk_live_x");
    mockResolve.mockResolvedValue(ACCOUNT);
    mockGet.mockResolvedValue({ connections: [] });

    const result = await runInit({ cwd: tmpDir });

    expect(result.workspaceLink?.linked).toBe(true);
    const written = readWorkspaceLink(tmpDir);
    expect(written?.orgSlug).toBe("acme");
    expect(written?.workspaceId).toBe("ws_1");
    expect(written?.linkedAt).toEqual(expect.any(String));
    expect(out).toContain("Linked: Acme Inc / Production");
  });

  it("is idempotent — reuses an existing link without re-prompting", async () => {
    writeWorkspaceLink(tmpDir, {
      ...ACCOUNT,
      linkedAt: "2026-01-01T00:00:00Z",
    });
    mockToken.mockReturnValue("oxk_live_x");
    mockGet.mockResolvedValue({ connections: [] });

    const result = await runInit({ cwd: tmpDir });

    expect(mockResolve).not.toHaveBeenCalled();
    expect(result.workspaceLink?.linked).toBe(true);
    expect(out).toContain("Already linked: Acme Inc / Production");
  });

  it("reports a picker failure as a skip rather than throwing", async () => {
    mockToken.mockReturnValue("oxk_live_x");
    mockResolve.mockRejectedValue(new Error("no organizations"));

    const result = await runInit({ cwd: tmpDir });

    expect(result.workspaceLink?.linked).toBe(false);
    expect(result.workspaceLink?.skippedReason).toContain("no organizations");
    expect(existsSync(workspaceLinkPath(tmpDir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runInit — the GitHub connection step (best-effort, never fatal)
// ---------------------------------------------------------------------------

describe("runInit GitHub step", () => {
  beforeEach(() => {
    mockToken.mockReturnValue("oxk_live_x");
    mockResolve.mockResolvedValue(ACCOUNT);
  });

  it("reports an existing connected GitHub connection", async () => {
    mockGet.mockResolvedValue({
      connections: [
        {
          id: "c1",
          publicId: "con_1",
          connectorId: "github",
          displayName: "GitHub",
          status: "connected",
        },
      ],
    });
    const result = await runInit({ cwd: tmpDir });
    expect(out).toContain("GitHub connection: GitHub (connected)");
    expect(result.workspaceLink?.linked).toBe(true);
  });

  it("ignores a github connection that is not yet connected", async () => {
    mockGet.mockResolvedValue({
      connections: [
        {
          id: "c1",
          publicId: "con_1",
          connectorId: "github",
          displayName: "GitHub",
          status: "pending_setup",
        },
      ],
    });
    await runInit({ cwd: tmpDir });
    expect(out).toContain("No GitHub connection found");
  });

  it("tells a non-interactive caller to re-run interactively", async () => {
    mockGet.mockResolvedValue({ connections: [] });
    await runInit({ cwd: tmpDir });
    expect(out).toContain("Run `oxagen init` interactively to connect");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("prints and continues when the connection check fails", async () => {
    mockGet.mockRejectedValue(new Error("connections endpoint down"));
    const result = await runInit({ cwd: tmpDir });
    expect(out).toContain("GitHub connection check failed");
    expect(out).toContain("connections endpoint down");
    // Still linked: the GitHub step is best-effort.
    expect(result.workspaceLink?.linked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleInit — the CLI writer
// ---------------------------------------------------------------------------

describe("handleInit", () => {
  it("prints the human summary by default", async () => {
    await handleInit({ cwd: tmpDir, noLink: true });
    expect(out).toContain("Workspace link:");
    expect(out).toContain("Skipped (--no-link)");
  });

  it("prints the raw result with --json", async () => {
    await handleInit({ cwd: tmpDir, noLink: true, json: true });
    const parsed = JSON.parse(out) as InitResult;
    expect(parsed.workspaceLink).toBeNull();
    expect(parsed.workspaceLinkPath).toBe(workspaceLinkPath(tmpDir));
  });
});
