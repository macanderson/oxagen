/**
 * Unit tests for project/init.ts.
 *
 * Covers:
 *   - promptConfirm: TTY (real prompt) vs non-TTY (auto-approve) behaviour.
 *   - initializeProject: creates the local project scaffold without network access.
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

let cwd: string;
const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
const originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "oxagen-init-"));
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
  });

  it("returns false when the project is already initialized", async () => {
    await initializeProject({ cwd, approver: async () => true });
    expect(isProjectInitialized(cwd)).toBe(true);
    const ok = await initializeProject({ cwd, approver: async () => true });
    expect(ok).toBe(false);
  });

  it("creates the local scaffold without network side effects", async () => {
    writeFileSync(join(cwd, "README.md"), "# hello\nworld");

    const ok = await initializeProject({ cwd, approver: async () => true });

    expect(ok).toBe(true);
    expect(existsSync(join(cwd, ".oxagen", "settings.json"))).toBe(true);
  });
});
