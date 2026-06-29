/**
 * Unit tests for lib/open-browser.ts.
 *
 * Verifies that `openBrowser` calls the correct OS-level command for each
 * platform and never throws even when `spawn` itself throws.
 *
 * `node:child_process` is mocked so no real process is spawned.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Import AFTER mocking so the module receives the mocked spawn.
import { openBrowser } from "../open-browser";
import { spawn } from "node:child_process";

const mockSpawn = vi.mocked(spawn);

/** Minimal fake ChildProcess returned by our spawn mock. */
const fakeChild = (): ChildProcess => ({ unref: vi.fn() }) as unknown as ChildProcess;

beforeEach(() => {
  mockSpawn.mockReturnValue(fakeChild());
});

describe("openBrowser — platform dispatch", () => {
  it('uses "open" on darwin', () => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    openBrowser("https://example.com/auth");
    expect(mockSpawn).toHaveBeenCalledWith(
      "open",
      ["https://example.com/auth"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it('uses "cmd /c start" on win32', () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    openBrowser("https://example.com/auth");
    expect(mockSpawn).toHaveBeenCalledWith(
      "cmd",
      ["/c", "start", "", "https://example.com/auth"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it('uses "xdg-open" on linux', () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    openBrowser("https://example.com/auth");
    expect(mockSpawn).toHaveBeenCalledWith(
      "xdg-open",
      ["https://example.com/auth"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it('uses "xdg-open" on any other platform (freebsd)', () => {
    Object.defineProperty(process, "platform", {
      value: "freebsd",
      configurable: true,
    });
    openBrowser("https://example.com/auth");
    expect(mockSpawn).toHaveBeenCalledWith(
      "xdg-open",
      ["https://example.com/auth"],
      expect.any(Object),
    );
  });
});

describe("openBrowser — error resilience", () => {
  it("never throws when spawn throws a synchronous error", () => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    mockSpawn.mockImplementationOnce(() => {
      throw new Error("ENOENT: spawn open not found");
    });
    expect(() => openBrowser("https://example.com/auth")).not.toThrow();
  });

  it("calls unref() on the spawned child so it does not keep the process alive", () => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    const child = fakeChild();
    mockSpawn.mockReturnValueOnce(child);
    openBrowser("https://example.com");
    expect(child.unref).toHaveBeenCalledOnce();
  });
});
