/**
 * Unit tests for project/init.ts.
 *
 * Covers:
 *   - promptConfirm: TTY (real prompt) vs non-TTY (auto-approve) behaviour.
 *   - initializeProject: the logged-out graceful-degrade path (no throw, no
 *     network) and the authenticated path (live markdown ingest). The API
 *     client is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mocks (declared before importing the module under test) ──────────────────

// Keep the settings default lightweight — avoids loading the model catalog deps.
vi.mock("../agent/model-catalog.js", () => ({
  DEFAULT_CODING_MODEL: "test/model",
}));

const apiMocks = vi.hoisted(() => ({
  resolveApiContext: vi.fn<() => unknown>(() => null),
  apiPostOrThrow: vi.fn<(path: string, body: unknown) => Promise<unknown>>(
    async () => ({}),
  ),
}));
vi.mock("../lib/api.js", () => ({
  resolveApiContext: apiMocks.resolveApiContext,
  apiPostOrThrow: apiMocks.apiPostOrThrow,
}));

// readline is only exercised by the TTY promptConfirm test.
const rlMock = vi.hoisted(() => ({
  question: vi.fn(async () => "y"),
  close: vi.fn(),
}));
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => rlMock),
}));

import {
  initializeProject,
  isProjectInitialized,
  promptConfirm,
} from "./init.js";

const AUTHED_CTX = {
  apiUrl: "https://api.test",
  token: "t",
  org: "org_1",
  ws: "ws_1",
};

let cwd: string;
const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
const originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "oxagen-init-"));
  apiMocks.resolveApiContext.mockReset().mockReturnValue(null);
  apiMocks.apiPostOrThrow.mockReset().mockResolvedValue({});
  rlMock.question.mockReset().mockResolvedValue("y");
  rlMock.close.mockReset();
  logSpy.mockClear();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  // Restore the original TTY flag mutated by promptConfirm tests.
  Object.defineProperty(process.stdin, "isTTY", {
    value: originalIsTTY,
    configurable: true,
  });
});

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
  });
}

describe("promptConfirm", () => {
  it("auto-approves without prompting when stdin is not a TTY (headless)", async () => {
    setTTY(false);
    const ok = await promptConfirm("Proceed?");
    expect(ok).toBe(true);
    expect(rlMock.question).not.toHaveBeenCalled();
  });

  it("prompts and returns true on an explicit yes at a TTY", async () => {
    setTTY(true);
    rlMock.question.mockResolvedValue("y");
    const ok = await promptConfirm("Proceed?");
    expect(ok).toBe(true);
    expect(rlMock.question).toHaveBeenCalledTimes(1);
    expect(rlMock.close).toHaveBeenCalledTimes(1);
  });

  it("returns false on any non-yes answer at a TTY", async () => {
    setTTY(true);
    rlMock.question.mockResolvedValue("n");
    expect(await promptConfirm("Proceed?")).toBe(false);
    rlMock.question.mockResolvedValue("");
    expect(await promptConfirm("Proceed?")).toBe(false);
  });
});

describe("initializeProject", () => {
  it("returns false and does nothing when the approver declines", async () => {
    const ok = await initializeProject({ cwd, approver: async () => false });
    expect(ok).toBe(false);
    expect(existsSync(join(cwd, ".oxagen"))).toBe(false);
    expect(apiMocks.apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("returns false when the project is already initialized", async () => {
    await initializeProject({ cwd, approver: async () => true });
    expect(isProjectInitialized(cwd)).toBe(true);
    const ok = await initializeProject({ cwd, approver: async () => true });
    expect(ok).toBe(false);
  });

  it("degrades gracefully when logged out — scaffolds, skips network, never throws", async () => {
    apiMocks.resolveApiContext.mockReturnValue(null);
    writeFileSync(join(cwd, "README.md"), "# hello\nworld");

    const ok = await initializeProject({ cwd, approver: async () => true });

    expect(ok).toBe(true);
    expect(existsSync(join(cwd, ".oxagen", "settings.json"))).toBe(true);
    // No platform calls attempted while logged out.
    expect(apiMocks.apiPostOrThrow).not.toHaveBeenCalled();
    // The skip is announced clearly, not silently.
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("Not signed in");
    expect(logged).toContain("oxagen login");
  });

  it("ingests markdown when authenticated", async () => {
    apiMocks.resolveApiContext.mockReturnValue(AUTHED_CTX);
    writeFileSync(join(cwd, "README.md"), "# readme\ncontent");
    writeFileSync(join(cwd, "GUIDE.md"), "# guide\nmore content");

    const ok = await initializeProject({ cwd, approver: async () => true });

    expect(ok).toBe(true);
    // Each markdown file ingested via the live graph.ingest capability.
    const ingestCalls = apiMocks.apiPostOrThrow.mock.calls.filter(
      (c) => c[0] === "graph/ingest",
    );
    expect(ingestCalls).toHaveLength(2);
    for (const call of ingestCalls) {
      const body = call[1] as { text: string; sourceUrl: string };
      expect(typeof body.text).toBe("string");
      expect(body.text.length).toBeGreaterThan(0);
      expect(body.sourceUrl).toMatch(/\.md$/);
    }
  });

  it("reports when authenticated but there are no markdown files", async () => {
    apiMocks.resolveApiContext.mockReturnValue(AUTHED_CTX);
    const ok = await initializeProject({ cwd, approver: async () => true });
    expect(ok).toBe(true);
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("No markdown files found");
  });
});
